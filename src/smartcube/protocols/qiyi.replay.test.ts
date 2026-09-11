import { describe, it, expect } from 'vitest';
import { ModeOfOperation } from 'aes-js';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moves } from '../../test/helpers/events';
import { qiyiProtocol } from './qiyi';

const QIYI_KEY = [87, 177, 249, 171, 205, 90, 232, 167, 156, 185, 140, 231, 87, 140, 81, 8];
const QIYI_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb';
const QIYI_CHARACTERISTIC = '0000fff6-0000-1000-8000-00805f9b34fb';

function crc16modbus(data: number[]): number {
  let crc = 0xffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc & 1) === 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
  }
  return crc;
}

function encryptedUnknownOpcode(opcode: number): { encrypted: string; decrypted: number[] } {
  const decrypted = [0xfe, 9, opcode, 0, 0, 0, 0];
  const crc = crc16modbus(decrypted);
  decrypted.push(crc & 0xff, crc >> 8);
  while (decrypted.length % 16 !== 0) decrypted.push(0);
  const encrypted = new ModeOfOperation.ecb(new Uint8Array(QIYI_KEY)).encrypt(
    new Uint8Array(decrypted),
  );
  return {
    encrypted: Array.from(encrypted, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    decrypted,
  };
}

describe('qiyiProtocol.connect (capture replay)', () => {
  it('publishes an unknown opcode only through the opt-in diagnostic stream', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const unknown = encryptedUnknownOpcode(0x99);
    const { device, replayer } = installMockBluetoothFromFixture(
      {
        ...fixture,
        traffic: [
          ...fixture.traffic,
          {
            t: Number.MAX_SAFE_INTEGER,
            op: 'notify',
            service: QIYI_SERVICE,
            characteristic: QIYI_CHARACTERISTIC,
            data: unknown.encrypted,
          },
        ],
      },
      { deviceId: 'qiyi-diagnostics' },
    );
    const conn = await qiyiProtocol.connect(device, async () => fixture.device.mac ?? null, {
      serviceUuids: serviceUuidsFromFixture(fixture),
      advertisementManufacturerData: null,
      enableAddressSearch: false,
      onStatus: undefined,
      signal: undefined,
      diagnostics: true,
    });
    const diagnostics: unknown[] = [];
    const unsubscribe = conn.diagnostics$?.subscribe((event) => diagnostics.push(event));
    const { events, unsubscribe: unsubscribeEvents } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe?.unsubscribe();
    unsubscribeEvents();

    expect(diagnostics).toEqual([
      {
        type: 'UNKNOWN_PACKET',
        protocol: 'qiyi',
        timestamp: expect.any(Number),
        opcode: 0x99,
        bytes: unknown.decrypted.slice(0, 9),
      },
    ]);
    expect(events.some((event) => (event as { type: string }).type === 'UNKNOWN_PACKET')).toBe(false);
    await conn.disconnect();
  }, 20_000);

  it('matches fixture decoded events', async () => {
    const fixture = await loadFixture(FIXTURES.qiyi);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'qiyi-replay' });

    const conn = await qiyiProtocol.connect(
      device,
      async () => fixture.device.mac ?? null,
      {
        serviceUuids: serviceUuidsFromFixture(fixture),
        advertisementManufacturerData: null,
        enableAddressSearch: false,
        onStatus: undefined,
        signal: undefined,
      }
    );

    const { events, unsubscribe } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 25);
    const expectedLast = fixtureExpectedLastFacelets(fixture);
    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);

    await conn.disconnect();
  }, 20_000);
});
