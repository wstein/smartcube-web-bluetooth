
import { Observable } from 'rxjs';

type SmartCubeMoveEvent = {
    type: "MOVE";
    /** Protocol-provided rolling move/state counter, when available. */
    serial?: number;
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
};

type SmartCubeDisconnectEvent = {
    type: "DISCONNECT";
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
}

interface SmartCubeConnection {
    readonly deviceName: string;
    readonly deviceMAC: string;
    readonly protocol: SmartCubeProtocolInfo;
    readonly capabilities: SmartCubeCapabilities;
    events$: Observable<SmartCubeEvent>;
    sendCommand(command: SmartCubeCommand): Promise<void>;
    disconnect(): Promise<void>;
}

type MacAddressProvider = (device: BluetoothDevice, isFallbackCall?: boolean) => Promise<string | null>;

export type {
    SmartCubeEvent,
    SmartCubeEventMessage,
    SmartCubeMoveEvent,
    SmartCubeFaceletsEvent,
    SmartCubeCubieState,
    SmartCubeGyroEvent,
    SmartCubeBatteryEvent,
    SmartCubeProtocolInfo,
    SmartCubeHardwareEvent,
    SmartCubeDisconnectEvent,
    SmartCubeCommand,
    SmartCubeCapabilities,
    SmartCubeConnection,
    MacAddressProvider
};
