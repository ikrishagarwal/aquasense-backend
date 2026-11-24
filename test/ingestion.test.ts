import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { handleMqttMessage } from '../src/ingestion/handlers.js';
import { telemetryPayloadSchema } from '../src/ingestion/schemas.js';

const device_id = '11111111-1111-4111-8111-111111111111';
const event_id = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-10-20T12:00:00.000000+00:00';
const event = {
  schema_version: 1, device_id, event_id, revision: 1, user_id: 'guest',
  start_ts: timestamp, end_ts: timestamp, volume_ml: 125.75, pulse_count: 12,
  temperature_c: null, tds_in: null, tds_out: null, ph_approx: null,
  sensor_quality: {
    temperature_c: 'sensor_error', tds_in: 'stale', tds_out: 'sensor_error', ph_approx: 'sensor_error',
  },
  confidence: null, recognition_status: 'disabled', volume_quality: 'uncalibrated',
  incomplete: true, quality_flags: ['interrupted'],
};
const wire = (message: unknown) => Buffer.from(JSON.stringify(message));

function harness(result = 'committed', error: object | null = null) {
  const calls: unknown[] = [];
  const logs: unknown[] = [];
  const context = {
    supabase: {
      async rpc(name: string, args: object) {
        calls.push([name, args]);
        return { data: result, error };
      },
    } as unknown as SupabaseClient,
    logger: { warn(...args: unknown[]) { logs.push(args); } } as FastifyBaseLogger,
    async publishCommitAck(...args: unknown[]) { calls.push(args); },
  };
  return { calls, logs, context };
}

test('persists the unchanged guest payload and ACKs only after the transaction returns', async () => {
  const { calls, context } = harness();
  await handleMqttMessage(context, `purifier/${device_id}/events`, wire(event));
  assert.deepEqual(calls, [
    ['commit_edge_event', { p_kind: 'dispense', p_payload: event }],
    [device_id, event_id, 1],
  ]);
});

test('propagates transaction errors without acknowledgement', async () => {
  const { calls, context } = harness('committed', { message: 'database unavailable' });
  await assert.rejects(handleMqttMessage(context, `purifier/${device_id}/events`, wire(event)));
  assert.equal(calls.length, 1);
});

test('ACKs exact duplicates and withholds ACKs for unknown devices, conflicts, and gaps', async () => {
  for (const result of ['committed', 'unknown_device', 'conflict', 'revision_gap']) {
    const { calls, context } = harness(result);
    await handleMqttMessage(context, `purifier/${device_id}/events`, wire(event));
    await handleMqttMessage(context, `purifier/${device_id}/events`, wire(event));
    assert.equal(calls.length, result === 'committed' ? 4 : 2);
  }
});

test('rejects wrong-device, malformed, oversized, and unknown-field payloads without raw logs', async () => {
  const { calls, logs, context } = harness();
  const topic = `purifier/${device_id}/events`;
  for (const payload of [
    wire({ ...event, device_id: event_id }), Buffer.from('SENSITIVE malformed JSON'),
    Buffer.alloc(16_385), wire({ ...event, unknown: true }), wire({ ...event, tds_in: 0 }),
  ]) await handleMqttMessage(context, topic, payload);
  assert.equal(calls.length, 0);
  assert.equal(logs.length, 5);
  assert.ok(!JSON.stringify(logs).includes('SENSITIVE'));
});

test('uses the same commit acknowledgement for lifecycle revisions', async () => {
  const { calls, context } = harness();
  const payload = {
    schema_version: 1, device_id, event_id, command_id: event_id, revision: 2,
    type: 'command_ack', status: 'rejected', reason: 'actuation_disabled', valve_state: 'commanded_closed', timestamp,
  };
  await handleMqttMessage(context, `purifier/${device_id}/ack`, wire(payload));
  assert.deepEqual(calls, [
    ['commit_edge_event', { p_kind: 'command_ack', p_payload: payload }],
    [device_id, event_id, 2],
  ]);
});

test('accepts the current Pi telemetry health and nullable sensor format', () => {
  assert.ok(telemetryPayloadSchema.safeParse({
    schema_version: 1, device_id, timestamp, tank_state: 'UNKNOWN', sensors: {
      tds_in: { value: null, quality: 'stale', unit: 'ppm', timestamp },
    },
    health: {
      core_rss_kib: 512, cpu_temperature_c: null, disk_free_bytes: 123, writer_depth: 0,
      storage_healthy: true, throttling: null, vision: 'disabled', mqtt: 'connected',
      pending_outbox: 0, sqlite_integrity: null,
    },
  }).success);
});
