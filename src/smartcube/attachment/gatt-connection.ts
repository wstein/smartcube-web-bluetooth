/**
 * Return the device's current GATT server, opening it only when this script is
 * not already connected. This makes protocol initialization safe after GATT
 * discovery has established the connection.
 */
export async function getConnectedGattServer(device: BluetoothDevice): Promise<BluetoothRemoteGATTServer> {
    const gatt = device.gatt;
    if (!gatt) {
        throw new Error('GATT unavailable on this device');
    }
    return gatt.connected ? gatt : await gatt.connect();
}
