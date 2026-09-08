import type { SmartCubeProtocol } from '../protocol';

/**
 * Pick the protocol that best matches the GATT profile. A recognised device name
 * takes precedence over a higher-scoring but name-incompatible profile: some
 * vendors share a primary service UUID (notably GoCube and GAN Gen2).
 */
export function resolveProtocolByGatt(
    protocols: readonly SmartCubeProtocol[],
    serviceUuids: ReadonlySet<string>,
    device: BluetoothDevice
): SmartCubeProtocol | null {
    const ranked = protocols.map((p) => ({
        p,
        score: p.gattAffinity(serviceUuids, device),
    }));
    const maxScore = ranked.reduce((m, r) => Math.max(m, r.score), -1);

    if (maxScore > 0) {
        const named = ranked
            .filter((r) => r.score > 0)
            .filter((r) => r.p.matchesDevice(device));
        if (named.length > 0) {
            return named.reduce((best, candidate) =>
                candidate.score > best.score ? candidate : best
            ).p;
        }
        const top = ranked.filter((r) => r.score === maxScore);
        return top[0].p;
    }

    for (const p of protocols) {
        if (p.matchesDevice(device)) {
            return p;
        }
    }

    return null;
}
