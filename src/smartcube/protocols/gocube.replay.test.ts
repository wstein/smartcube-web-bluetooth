import { describe, it, expect } from 'vitest';
import type { SmartCubeEvent } from '../types';
import { FIXTURES, loadFixture } from '../../test/fixtures';
import { installMockBluetoothFromFixture } from '../../test/bluetooth-mock';
import { serviceUuidsFromFixture } from '../../test/helpers/fixture-replay';
import { collectEvents, fixtureExpectedLastFacelets, fixtureExpectedMoves, lastFacelets, moves } from '../../test/helpers/events';
import {
  decodeGoCubeCubeTypePayload,
  decodeGoCubeOfflineStatsPayload,
  goCubeProtocol,
  goCubeVendorCommandOpcode,
  parseGoCubeOrientationPayload,
} from './gocube';

describe('GoCube orientation payload', () => {
  it('returns null for invalid payloads', () => {
    expect(parseGoCubeOrientationPayload('')).toBeNull();
    expect(parseGoCubeOrientationPayload('1#2#3')).toBeNull();
    expect(parseGoCubeOrientationPayload('a#b#c#d')).toBeNull();
    expect(parseGoCubeOrientationPayload('0#0#0#0')).toBeNull();
  });

  it('normalizes and remaps axes for valid payload', () => {
    const q = parseGoCubeOrientationPayload('1#0#0#0');
    expect(q).not.toBeNull();
    // rx=1 gives nx=1, ny=nz=nw=0; mapped to { x: nx, y:-nz, z:-ny, w:nw }
    expect(q).toEqual({ x: 1, y: -0, z: -0, w: 0 });
  });
});

describe('GoCube protocol metadata', () => {
  it('decodes Edge type and offline statistics', () => {
    expect(decodeGoCubeCubeTypePayload(new Uint8Array([1]))).toEqual({ code: 1, name: 'edge' });
    expect(decodeGoCubeOfflineStatsPayload('123#456#7')).toEqual({
      moves: 123,
      timeSeconds: 456,
      solves: 7,
    });
  });

  it('maps supported vendor commands to their UART opcodes', () => {
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'REBOOT' })).toBe(0x34);
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'SET_ORIENTATION_ENABLED', enabled: false })).toBe(0x37);
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'SET_ORIENTATION_ENABLED', enabled: true })).toBe(0x38);
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'CALIBRATE_ORIENTATION' })).toBe(0x57);
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'FLASH_BACKLIGHT' })).toBe(0x41);
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'SLOW_FLASH_BACKLIGHT' })).toBe(0x43);
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'TOGGLE_ANIMATED_BACKLIGHT' })).toBe(0x42);
    expect(goCubeVendorCommandOpcode({ vendor: 'gocube', type: 'TOGGLE_BACKLIGHT' })).toBe(0x44);
  });
});

describe('gocubeProtocol.connect (capture replay)', () => {
  it('matches fixture decoded events for classic GoCube', async () => {
    const fixture = await loadFixture(FIXTURES.gocube);
    // Allow enough immediate notifies for init (initial state) but keep most for post-connect subscription.
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'gocube', maxAutoFlushNotifies: 5 });

    const conn = await goCubeProtocol.connect(device, undefined, {
      serviceUuids: serviceUuidsFromFixture(fixture),
      advertisementManufacturerData: null,
      enableAddressSearch: false,
      onStatus: undefined,
      signal: undefined,
      diagnostics: true,
    });

    const { events, unsubscribe } = collectEvents(conn);
    const diagnostics: unknown[] = [];
    const diagnosticsSubscription = conn.diagnostics$?.subscribe((event) => diagnostics.push(event));

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 25);
    const expectedLast = fixtureExpectedLastFacelets(fixture);
    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);
    expect(events.find((event) => event.type === 'MOVE')).toMatchObject({
      goCubeCenterOrientation: expect.any(Number),
    });
    expect(events.find((event) => event.type === 'FACELETS')).toMatchObject({
      state: { CP: expect.any(Array), CO: expect.any(Array), EP: expect.any(Array), EO: expect.any(Array) },
    });

    // gyro should be supported for classic GoCube
    expect(conn.capabilities.gyroscope).toBe(true);
    expect(conn.capabilities.vendorCommands).toContain('REBOOT');
    expect(conn.sendVendorCommand).toBeTypeOf('function');
    expect(diagnostics.some((event) => (event as { type: string }).type === 'RAW_PACKET')).toBe(true);
    diagnosticsSubscription?.unsubscribe();

    const disconnectEvents: SmartCubeEvent[] = [];
    const sub2 = conn.events$.subscribe({ next: (e) => disconnectEvents.push(e) });
    await conn.disconnect();
    sub2.unsubscribe();
    expect(disconnectEvents.some((e) => e.type === 'DISCONNECT')).toBe(true);
  }, 20_000);

  it('matches fixture decoded events for Rubik’s Connected (no gyro)', async () => {
    const fixture = await loadFixture(FIXTURES.rubiksConnected);
    const { device, replayer } = installMockBluetoothFromFixture(fixture, { deviceId: 'rubiks', maxAutoFlushNotifies: 1 });

    const conn = await goCubeProtocol.connect(device, undefined, {
      serviceUuids: serviceUuidsFromFixture(fixture),
      advertisementManufacturerData: null,
      enableAddressSearch: false,
      onStatus: undefined,
      signal: undefined,
    });

    const { events, unsubscribe } = collectEvents(conn);

    await replayer.drainNotificationsAsync();
    unsubscribe();

    const expectedMoves = fixtureExpectedMoves(fixture, 25);
    const expectedLast = fixtureExpectedLastFacelets(fixture);
    expect(moves(events).slice(0, expectedMoves.length)).toEqual(expectedMoves);
    expect(lastFacelets(events)).toBe(expectedLast);

    // Rubik’s Connected lacks IMU in this protocol impl
    expect(conn.capabilities.gyroscope).toBe(false);
    expect(events.some((e) => e.type === 'GYRO')).toBe(false);

    await conn.disconnect();
  }, 20_000);
});
