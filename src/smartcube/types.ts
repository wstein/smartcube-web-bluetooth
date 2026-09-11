
import { Observable } from 'rxjs';

type SmartCubeMoveEvent = {
    type: "MOVE";
    /** Protocol-provided rolling move/state counter, when available. */
    serial?: number;
    /** GoCube center-piece orientation byte, when supplied by its rotation frame. */
    goCubeCenterOrientation?: number;
    face: number;
    direction: number;
    move: string;
    localTimestamp: number | null;
    cubeTimestamp: number | null;
};

/** Cubie permutation and orientation state supplied by some cube protocols. */
type SmartCubeCubieState = {
    /** Corner permutation: 8 values from 0 to 7. */
    CP: number[];
    /** Corner orientation: 8 values from 0 to 2. */
    CO: number[];
    /** Edge permutation: 12 values from 0 to 11. */
    EP: number[];
    /** Edge orientation: 12 values from 0 to 1. */
    EO: number[];
};

type SmartCubeFaceletsEvent = {
    type: "FACELETS";
    /** Protocol-provided rolling move/state counter, when available. */
    serial?: number;
    facelets: string;
    /** Cubie permutation and orientation state, when available. */
    state?: SmartCubeCubieState;
};

type GoCubeType = {
    code: number;
    name: string;
};

type GoCubeOfflineStats = {
    moves: number;
    timeSeconds: number;
    solves: number;
};

type GoCubeVendorCommand =
    | { vendor: 'gocube'; type: 'REBOOT' }
    | { vendor: 'gocube'; type: 'SET_ORIENTATION_ENABLED'; enabled: boolean }
    | { vendor: 'gocube'; type: 'CALIBRATE_ORIENTATION' }
    | { vendor: 'gocube'; type: 'FLASH_BACKLIGHT' }
    | { vendor: 'gocube'; type: 'SLOW_FLASH_BACKLIGHT' }
    | { vendor: 'gocube'; type: 'TOGGLE_ANIMATED_BACKLIGHT' }
    | { vendor: 'gocube'; type: 'TOGGLE_BACKLIGHT' };

type SmartCubeVendorCommand = GoCubeVendorCommand;

type SmartCubeGyroEvent = {
    type: "GYRO";
    quaternion: { x: number; y: number; z: number; w: number };
    velocity?: { x: number; y: number; z: number };
};

type SmartCubeBatteryEvent = {
    type: "BATTERY";
    batteryLevel: number;
};

type SmartCubeProtocolInfo = {
    id: string;
    name: string;
};

type SmartCubeHardwareEvent = {
    type: "HARDWARE";
    hardwareName?: string;
    softwareVersion?: string;
    hardwareVersion?: string;
    productDate?: string;
    gyroSupported?: boolean;
    /** GoCube model type returned by its vendor protocol. */
    goCubeType?: GoCubeType;
    /** GoCube Edge cumulative offline statistics returned by its vendor protocol. */
    goCubeOfflineStats?: GoCubeOfflineStats;
};

type SmartCubeDisconnectEvent = {
    type: "DISCONNECT";
};

/**
 * Opt-in protocol diagnostic. These packets are intentionally separate from
 * `events$`: a decoder could not map them to cube state, so applications must
 * never treat them as moves or snapshots.
 */
type SmartCubeDiagnosticEvent = {
    type: 'RAW_PACKET' | 'DECODED_PACKET' | 'MALFORMED_PACKET' | 'UNKNOWN_PACKET';
    protocol: string;
    timestamp: number;
    opcode?: number;
    bytes: readonly number[];
    reason?: string;
};

type SmartCubeEventMessage =
    | SmartCubeMoveEvent
    | SmartCubeFaceletsEvent
    | SmartCubeGyroEvent
    | SmartCubeBatteryEvent
    | SmartCubeHardwareEvent
    | SmartCubeDisconnectEvent;

type SmartCubeEvent = { timestamp: number } & SmartCubeEventMessage;

type SmartCubeCommand =
    | { type: "REQUEST_FACELETS" }
    | { type: "REQUEST_BATTERY" }
    | { type: "REQUEST_HARDWARE" }
    | { type: "REQUEST_RESET" };

interface SmartCubeCapabilities {
    gyroscope: boolean;
    battery: boolean;
    facelets: boolean;
    hardware: boolean;
    reset: boolean;
    /** Protocol-specific commands available through `sendVendorCommand`. */
    vendorCommands?: readonly SmartCubeVendorCommand['type'][];
}

interface SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo;
    readonly capabilities: SmartCubeCapabilities;
    events$: Observable<SmartCubeEvent>;
    /** Present only when diagnostics were requested at connection time. */
    diagnostics$?: Observable<SmartCubeDiagnosticEvent>;
    sendCommand(command: SmartCubeCommand): Promise<void>;
    /** Send an optional protocol-specific command after checking `capabilities.vendorCommands`. */
    sendVendorCommand?(command: SmartCubeVendorCommand): Promise<void>;
    disconnect(): Promise<void>;
}

type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

export type {
    SmartCubeEvent,
    SmartCubeEventMessage,
    SmartCubeMoveEvent,
    SmartCubeFaceletsEvent,
    SmartCubeCubieState,
    GoCubeType,
    GoCubeOfflineStats,
    GoCubeVendorCommand,
    SmartCubeVendorCommand,
    SmartCubeGyroEvent,
    SmartCubeBatteryEvent,
    SmartCubeProtocolInfo,
    SmartCubeHardwareEvent,
    SmartCubeDisconnectEvent,
    SmartCubeDiagnosticEvent,
    SmartCubeCommand,
    SmartCubeCapabilities,
    SmartCubeConnection,
    MacAddressProvider
};
