import { describe, expect, it, vi } from 'vitest';
import { getConnectedGattServer } from '../../smartcube/attachment/gatt-connection';

describe('getConnectedGattServer', () => {
  it('reuses an already-connected GATT server without calling connect again', async () => {
    const connect = vi.fn();
    const gatt = { connected: true, connect } as unknown as BluetoothRemoteGATTServer;
    const device = { gatt } as unknown as BluetoothDevice;

    await expect(getConnectedGattServer(device)).resolves.toBe(gatt);
    expect(connect).not.toHaveBeenCalled();
  });

  it('connects and returns a disconnected GATT server', async () => {
    const gatt = {
      connected: false,
      connect: vi.fn(),
    } as unknown as { connected: boolean; connect: ReturnType<typeof vi.fn> };
    gatt.connect.mockResolvedValue(gatt);
    const device = { gatt } as unknown as BluetoothDevice;

    await expect(getConnectedGattServer(device)).resolves.toBe(gatt);
    expect(gatt.connect).toHaveBeenCalledTimes(1);
  });

  it('rejects devices without GATT support', async () => {
    await expect(getConnectedGattServer({ gatt: undefined } as BluetoothDevice)).rejects.toThrow(
      'GATT unavailable on this device'
    );
  });
});
