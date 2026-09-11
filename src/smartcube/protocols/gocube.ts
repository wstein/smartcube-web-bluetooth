
import { ReplaySubject, Subject } from 'rxjs';
import { GoCubeOfflineStats, GoCubeType, GoCubeVendorCommand, SmartCubeConnection, SmartCubeDiagnosticEvent, SmartCubeEvent, SmartCubeCommand, SmartCubeCapabilities, SmartCubeProtocolInfo, MacAddressProvider } from '../types';
import type { AttachmentContext } from '../attachment/types';
import { normalizeUuid } from '../attachment/normalize-uuid';
import { getConnectedGattServer } from '../attachment/gatt-connection';
import { SmartCubeProtocol, registerProtocol } from '../protocol';
import { CubieCube, SOLVED_FACELET } from '../cubie-cube';
import { now } from '../ble-utils';
import { writeGattCharacteristicValue } from '../../gatt-characteristic-write';

const UUID_SUFFIX = '-b5a3-f393-e0a9-e50e24dcca9e';
const SERVICE_UUID = '6e400001' + UUID_SUFFIX;
const CHRCT_UUID_WRITE = '6e400002' + UUID_SUFFIX;
const CHRCT_UUID_READ = '6e400003' + UUID_SUFFIX;

const WRITE_BATTERY = 50;
const WRITE_STATE = 51;
const WRITE_RESET = 53;
/** Enable MsgOrientation (3D tracking). Rubik's Connected / GoCube X omit IMU; only classic GoCube uses this. */
const WRITE_ENABLE_ORIENTATION = 0x38;
const WRITE_REBOOT = 0x34;
const WRITE_DISABLE_ORIENTATION = 0x37;
const WRITE_REQUEST_OFFLINE_STATS = 0x39;
const WRITE_FLASH_BACKLIGHT = 0x41;
const WRITE_TOGGLE_ANIMATED_BACKLIGHT = 0x42;
const WRITE_SLOW_FLASH_BACKLIGHT = 0x43;
const WRITE_TOGGLE_BACKLIGHT = 0x44;
const WRITE_REQUEST_CUBE_TYPE = 0x56;
const WRITE_CALIBRATE_ORIENTATION = 0x57;

const INITIAL_STATE_TIMEOUT_MS = 5000;

/** True for classic GoCube (incl. `GoCube_*`); false for Rubik's Connected and GoCube X (same UART, no gyro). */
function goCubeDeviceSupportsGyro(deviceName: string): boolean {
    if (!deviceName.startsWith('GoCube')) {
        return false;
    }
    if (deviceName.startsWith('GoCubeX')) {
        return false;
    }
    return true;
}

/** Sum of bytes 0..(checksum-1) mod 256 equals checksum byte (immediately before CRLF). */
function gocubeChecksumValid(value: DataView): boolean {
    if (value.byteLength < 7) {
        return false;
    }
    let sum = 0;
    for (let i = 0; i <= value.byteLength - 4; i++) {
        sum += value.getUint8(i);
    }
    return (sum & 0xff) === value.getUint8(value.byteLength - 3);
}

/**
 * MsgOrientation payload: ASCII decimals `x#y#z#w` (see public GoCube UART docs). Normalize to a unit quaternion.
 * Integer components are scaled together so normalization yields the physical orientation.
 *
 * Wire `(rx,ry,rz,rw)` normalized to `(nx,ny,nz,nw)` then mapped to `(nx, -nz, -ny, nw)`.
 */
export function parseGoCubeOrientationPayload(payloadUtf8: string): { x: number; y: number; z: number; w: number } | null {
    const parts = payloadUtf8.split('#');
    if (parts.length !== 4) {
        return null;
    }
    const rx = Number.parseInt(parts[0]!.trim(), 10);
    const ry = Number.parseInt(parts[1]!.trim(), 10);
    const rz = Number.parseInt(parts[2]!.trim(), 10);
    const rw = Number.parseInt(parts[3]!.trim(), 10);
    if (![rx, ry, rz, rw].every((n) => Number.isFinite(n))) {
        return null;
    }
    const len = Math.hypot(rx, ry, rz, rw);
    if (len === 0) {
        return null;
    }
    const nx = rx / len;
    const ny = ry / len;
    const nz = rz / len;
    const nw = rw / len;
    return { x: nx, y: -nz, z: -ny, w: nw };
}

export function decodeGoCubeCubeTypePayload(payload: Uint8Array): GoCubeType | null {
    if (payload.length < 1) return null;
    const code = payload[0]!;
    return { code, name: code === 1 ? 'edge' : 'standard' };
}

export function decodeGoCubeOfflineStatsPayload(payloadUtf8: string): GoCubeOfflineStats | null {
    const values = payloadUtf8.split('#').map((part) => Number.parseInt(part, 10));
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) return null;
    return { moves: values[0]!, timeSeconds: values[1]!, solves: values[2]! };
}

export function goCubeVendorCommandOpcode(command: GoCubeVendorCommand): number {
    switch (command.type) {
        case 'REBOOT': return WRITE_REBOOT;
        case 'SET_ORIENTATION_ENABLED': return command.enabled ? WRITE_ENABLE_ORIENTATION : WRITE_DISABLE_ORIENTATION;
        case 'CALIBRATE_ORIENTATION': return WRITE_CALIBRATE_ORIENTATION;
        case 'FLASH_BACKLIGHT': return WRITE_FLASH_BACKLIGHT;
        case 'SLOW_FLASH_BACKLIGHT': return WRITE_SLOW_FLASH_BACKLIGHT;
        case 'TOGGLE_ANIMATED_BACKLIGHT': return WRITE_TOGGLE_ANIMATED_BACKLIGHT;
        case 'TOGGLE_BACKLIGHT': return WRITE_TOGGLE_BACKLIGHT;
    }
}

const AXIS_PERM = [5, 2, 0, 3, 1, 4];
const FACE_PERM = [0, 1, 2, 5, 8, 7, 6, 3];
const FACE_OFFSET = [0, 0, 6, 2, 0, 0];

/** Physical opposite faces in URFDLB axis order (U↔D, R↔L, F↔B). */
const OPPOSITE_AXIS = [3, 4, 5, 0, 1, 2];

const GOCUBE_PROTOCOL: SmartCubeProtocolInfo = { id: 'gocube', name: 'GoCube' };

class GoCubeConnection implements SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo = GOCUBE_PROTOCOL;
    readonly capabilities: SmartCubeCapabilities;
    events$: Subject<SmartCubeEvent>;
    diagnostics$?: ReplaySubject<SmartCubeDiagnosticEvent>;

    private device: BluetoothDevice;
    private readChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private writeChrct: BluetoothRemoteGATTCharacteristic | null = null;
    private curCubie = new CubieCube();
    private prevCubie = new CubieCube();
    private moveCntFree = 100;
    private lastBatteryLevel: number | null = null;
    private forceNextBatteryEmission = false;
    private batteryInterval: ReturnType<typeof setInterval> | null = null;
    /** Last decoded move (axis + direction bit) for short type-1 frames that omit a full pair of bytes. */
    private lastMoveMeta: { axis: number; dirBit: number } | null = null;
    /** First full-state (type 2) after connect: defer FACELETS until `init` finishes so subscribers never miss it. */
    private awaitingInitialState = false;
    private resolveInitialState: (() => void) | undefined;

    constructor(device: BluetoothDevice, name: string, gyroSupported: boolean, supportsVendorCommands: boolean, diagnostics = false) {
        this.device = device;
        this.deviceName = name;
        this.deviceMAC = '';
        let vendorCommands: SmartCubeCapabilities['vendorCommands'];
        if (supportsVendorCommands) {
            vendorCommands = [
                'REBOOT',
                'FLASH_BACKLIGHT',
                'SLOW_FLASH_BACKLIGHT',
                'TOGGLE_ANIMATED_BACKLIGHT',
                'TOGGLE_BACKLIGHT',
            ];
            if (gyroSupported) {
                vendorCommands = [
                    'REBOOT',
                    'SET_ORIENTATION_ENABLED',
                    'CALIBRATE_ORIENTATION',
                    'FLASH_BACKLIGHT',
                    'SLOW_FLASH_BACKLIGHT',
                    'TOGGLE_ANIMATED_BACKLIGHT',
                    'TOGGLE_BACKLIGHT',
                ];
            }
        }
        this.capabilities = {
            gyroscope: gyroSupported,
            battery: true,
            facelets: true,
            hardware: true,
            reset: true,
            ...(vendorCommands ? { vendorCommands } : {}),
        };
        this.events$ = new Subject<SmartCubeEvent>();
        if (diagnostics) this.diagnostics$ = new ReplaySubject<SmartCubeDiagnosticEvent>(32);
    }

    private diagnostic(type: SmartCubeDiagnosticEvent['type'], value: DataView, reason?: string): void {
        this.diagnostics$?.next({
            type,
            protocol: this.protocol.id,
            timestamp: now(),
            bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
            reason,
        });
    }

    private onStateChanged = (event: Event): void => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        this.diagnostic('RAW_PACKET', value);
        this.parseData(value);
    };

    private cubieState(cube: CubieCube = this.prevCubie) {
        return {
            CP: cube.ca.map((corner) => corner & 7),
            CO: cube.ca.map((corner) => corner >> 3),
            EP: cube.ea.map((edge) => edge >> 1),
            EO: cube.ea.map((edge) => edge & 1),
        };
    }

    private applySingleMove(timestamp: number, axis: number, dirBit: number, centerOrientation?: number): void {
        const power = [0, 2][dirBit];
        const m = axis * 3 + power;
        const moveStr = ("URFDLB".charAt(axis) + " 2'".charAt(power)).trim();

        CubieCube.CubeMult(this.prevCubie, CubieCube.moveCube[m], this.curCubie);
        const facelet = this.curCubie.toFaceCube();

        this.events$.next({
            timestamp,
            type: "MOVE",
            goCubeCenterOrientation: centerOrientation,
            face: axis,
            direction: power === 0 ? 0 : 1,
            move: moveStr,
            localTimestamp: timestamp,
            cubeTimestamp: null
        });

        this.events$.next({
            timestamp,
            type: "FACELETS",
            facelets: facelet,
            state: this.cubieState(this.curCubie)
        });

        const tmp = this.curCubie;
        this.curCubie = this.prevCubie;
        this.prevCubie = tmp;

        if (++this.moveCntFree > 20) {
            this.moveCntFree = 0;
            this.writeChrct &&
                writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_STATE]).buffer).catch(() => {});
        }
    }

    private emitBatteryLevel(rawLevel: number, timestamp = now()): void {
        if (!Number.isFinite(rawLevel)) {
            return;
        }
        const batteryLevel = Math.min(100, Math.max(0, Math.round(rawLevel)));
        const forceEmission = this.forceNextBatteryEmission;
        this.forceNextBatteryEmission = false;
        if (!forceEmission && this.lastBatteryLevel === batteryLevel) {
            return;
        }
        this.lastBatteryLevel = batteryLevel;
        this.events$.next({
            timestamp,
            type: 'BATTERY',
            batteryLevel,
        });
    }

    private pollBattery = (): void => {
        if (!this.writeChrct) {
            return;
        }
        writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_BATTERY]).buffer).catch(() => {});
    };

    private parseData(value: DataView): void {
        const timestamp = now();
        if (value.byteLength < 4) return;
        if (value.getUint8(0) !== 0x2a ||
            value.getUint8(value.byteLength - 2) !== 0x0d ||
            value.getUint8(value.byteLength - 1) !== 0x0a) {
            this.diagnostic('MALFORMED_PACKET', value, 'Invalid GoCube frame delimiters');
            return;
        }
        // Full frames include a checksum byte before CRLF; short type-1 move frames may be smaller.
        if (value.byteLength >= 7 && !gocubeChecksumValid(value)) {
            this.diagnostic('MALFORMED_PACKET', value, 'Invalid GoCube frame checksum');
            return;
        }

        const msgType = value.getUint8(2);
        const msgLen = value.byteLength - 6;

        if (msgType === 3) {
            // MsgOrientation: ASCII x#y#z#w between byte 3 and checksum.
            if (!this.capabilities.gyroscope || value.byteLength < 8) {
                return;
            }
            const end = value.byteLength - 3;
            const payload = new Uint8Array(value.buffer, value.byteOffset + 3, end - 3);
            const text = new TextDecoder('utf-8', { fatal: false }).decode(payload);
            const q = parseGoCubeOrientationPayload(text);
            if (!q) {
                return;
            }
            this.events$.next({
                timestamp,
                type: 'GYRO',
                quaternion: q
            });
            return;
        }

        if (msgType === 1) { // Move
            // Firmware may send a truncated type-1 frame (< 8 bytes): treat as opposite-face turn,
            // mirroring the last full move.
            if (value.byteLength < 8) {
                if (this.lastMoveMeta) {
                    const oppAxis = OPPOSITE_AXIS[this.lastMoveMeta.axis];
                    const newDirBit = 1 - this.lastMoveMeta.dirBit;
                    this.applySingleMove(timestamp, oppAxis, newDirBit);
                    this.lastMoveMeta = { axis: oppAxis, dirBit: newDirBit };
                }
                return;
            }
            for (let i = 0; i < msgLen; i += 2) {
                const axis = AXIS_PERM[value.getUint8(3 + i) >> 1];
                const dirBit = value.getUint8(3 + i) & 1;
                this.lastMoveMeta = { axis, dirBit };
                this.applySingleMove(timestamp, axis, dirBit, value.getUint8(4 + i));
            }
        } else if (msgType === 2) { // Cube state
            // Full-cube state is six 9-sticker faces in wire order; unpack with AXIS_PERM/FACE_PERM.
            const facelet: string[] = [];
            for (let a = 0; a < 6; a++) {
                const axis = AXIS_PERM[a] * 9;
                const aoff = FACE_OFFSET[a];
                facelet[axis + 4] = "BFUDRL".charAt(value.getUint8(3 + a * 9));
                for (let i = 0; i < 8; i++) {
                    facelet[axis + FACE_PERM[(i + aoff) % 8]] = "BFUDRL".charAt(value.getUint8(3 + a * 9 + i + 1));
                }
            }
            const newFacelet = facelet.join('');
            const curFacelet = this.prevCubie.toFaceCube();
            if (newFacelet !== curFacelet) {
                this.curCubie.fromFacelet(newFacelet);
                const tmp = this.curCubie;
                this.curCubie = this.prevCubie;
                this.prevCubie = tmp;
            }
            if (this.awaitingInitialState && this.resolveInitialState) {
                const done = this.resolveInitialState;
                this.resolveInitialState = undefined;
                this.awaitingInitialState = false;
                done();
                return;
            }
            this.events$.next({
                timestamp,
                type: "FACELETS",
                facelets: this.prevCubie.toFaceCube(),
                state: this.cubieState()
            });
        } else if (msgType === 5) { // Battery
            this.emitBatteryLevel(value.getUint8(3), timestamp);
        } else if (msgType === 7) { // Offline statistics
            const payload = new Uint8Array(value.buffer, value.byteOffset + 3, msgLen);
            const stats = decodeGoCubeOfflineStatsPayload(new TextDecoder().decode(payload));
            if (stats) this.events$.next({ timestamp, type: 'HARDWARE', goCubeOfflineStats: stats });
        } else if (msgType === 8) { // Cube type
            const payload = new Uint8Array(value.buffer, value.byteOffset + 3, msgLen);
            const cubeType = decodeGoCubeCubeTypePayload(payload);
            if (cubeType) this.events$.next({ timestamp, type: 'HARDWARE', goCubeType: cubeType });
        }
    }

    private emitHardwareEvent(): void {
        this.events$.next({
            timestamp: now(),
            type: "HARDWARE",
            hardwareName: this.deviceName,
            gyroSupported: this.capabilities.gyroscope
        });
    }

    private onDisconnect = (): void => {
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
    };

    async init(): Promise<void> {
        this.device.addEventListener('gattserverdisconnected', this.onDisconnect);
        // `connectSmartCube` has already opened GATT to inspect the service
        // profile. Reconnecting here can stall on real adapters; reuse it.
        const gatt = await getConnectedGattServer(this.device);
        const service = await gatt.getPrimaryService(SERVICE_UUID);
        this.writeChrct = await service.getCharacteristic(CHRCT_UUID_WRITE);
        this.readChrct = await service.getCharacteristic(CHRCT_UUID_READ);
        await this.readChrct.startNotifications();
        this.readChrct.addEventListener('characteristicvaluechanged', this.onStateChanged);

        if (this.capabilities.gyroscope) {
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_ENABLE_ORIENTATION]).buffer).catch(() => {});
        }

        const firstStatePromise = new Promise<void>((resolve) => {
            this.resolveInitialState = resolve;
        });
        this.awaitingInitialState = true;

        await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_STATE]).buffer);
        this.pollBattery();
        this.batteryInterval = setInterval(this.pollBattery, 60_000);

        await Promise.race([
            firstStatePromise,
            new Promise<void>((resolve) => setTimeout(resolve, INITIAL_STATE_TIMEOUT_MS))
        ]);
        this.awaitingInitialState = false;
        this.resolveInitialState = undefined;

        queueMicrotask(() => {
            this.events$.next({
                timestamp: now(),
                type: "FACELETS",
                facelets: this.prevCubie.toFaceCube(),
                state: this.cubieState()
            });
        });
    }

    async sendCommand(command: SmartCubeCommand): Promise<void> {
        if (!this.writeChrct) {
            return;
        }
        if (command.type === "REQUEST_BATTERY") {
            this.forceNextBatteryEmission = true;
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_BATTERY]).buffer);
        } else if (command.type === "REQUEST_FACELETS") {
            const ts = now();
            this.events$.next({
                timestamp: ts,
                type: "FACELETS",
                facelets: this.prevCubie.toFaceCube(),
                state: this.cubieState()
            });
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_STATE]).buffer);
        } else if (command.type === "REQUEST_HARDWARE") {
            this.emitHardwareEvent();
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_REQUEST_CUBE_TYPE]).buffer);
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_REQUEST_OFFLINE_STATS]).buffer);
        } else if (command.type === "REQUEST_RESET") {
            await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([WRITE_RESET]).buffer);
            this.curCubie = new CubieCube();
            this.prevCubie = new CubieCube();
            this.lastMoveMeta = null;
            this.moveCntFree = 100;
            this.lastBatteryLevel = null;
            this.forceNextBatteryEmission = false;
            this.events$.next({
                timestamp: now(),
                type: "FACELETS",
                facelets: SOLVED_FACELET,
                state: this.cubieState()
            });
        }
    }

    async sendVendorCommand(command: GoCubeVendorCommand): Promise<void> {
        if (!this.writeChrct || !this.capabilities.vendorCommands?.includes(command.type)) {
            throw new Error(`Unsupported GoCube vendor command: ${command.type}`);
        }
        await writeGattCharacteristicValue(this.writeChrct, new Uint8Array([goCubeVendorCommandOpcode(command)]).buffer);
    }

    async disconnect(): Promise<void> {
        if (this.readChrct) {
            this.readChrct.removeEventListener('characteristicvaluechanged', this.onStateChanged);
            await this.readChrct.stopNotifications().catch(() => {});
            this.readChrct = null;
        }
        this.lastBatteryLevel = null;
        this.forceNextBatteryEmission = false;
        if (this.batteryInterval) {
            clearInterval(this.batteryInterval);
            this.batteryInterval = null;
        }
        this.writeChrct = null;
        this.device.removeEventListener('gattserverdisconnected', this.onDisconnect);
        this.events$.next({ timestamp: now(), type: "DISCONNECT" });
        this.events$.complete();
        if (this.device.gatt?.connected) {
            this.device.gatt.disconnect();
        }
    }
}

const goCubeProtocol: SmartCubeProtocol = {
    nameFilters: [
        { namePrefix: 'GoCube_' },
        { namePrefix: 'GoCube' },
        { namePrefix: 'Rubiks' }
    ],
    optionalServices: [SERVICE_UUID],

    matchesDevice(device: BluetoothDevice): boolean {
        const name = device.name || '';
        return name.startsWith('GoCube') || name.startsWith('Rubiks');
    },

    gattAffinity(serviceUuids: ReadonlySet<string>, _device: BluetoothDevice): number {
        return serviceUuids.has(normalizeUuid(SERVICE_UUID)) ? 110 : 0;
    },

    async connect(
        device: BluetoothDevice,
        _macProvider?: MacAddressProvider,
        context?: AttachmentContext
    ): Promise<SmartCubeConnection> {
        const raw = device.name ?? '';
        const name = raw.startsWith('GoCube') ? 'GoCube' : 'Rubiks Connected';
        const conn = new GoCubeConnection(device, name, goCubeDeviceSupportsGyro(raw), raw.startsWith('GoCube'), context?.diagnostics === true);
        await conn.init();
        return conn;
    }
};

registerProtocol(goCubeProtocol);

export { goCubeProtocol };
