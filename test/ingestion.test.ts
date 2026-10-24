import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyBaseLogger } from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  commandAckPayloadSchema,
  deviceIdSchema,
  sessionPayloadSchema,
  statusPayloadSchema,
} from '../src/ingestion/schemas.js';

// The handler imports configuration at module load time. These values keep the
// unit tests self-contained and explicitly prevent any broker/database use.
Object.assign(process.env, {
  NODE_ENV: 'test',
  SUPABASE_URL: 'https://unit-test.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'unit-test-key',
  MQTT_URL: 'mqtt://unit-test.invalid',
  MQTT_USERNAME: 'unit-test-user',
  MQTT_PASSWORD: 'unit-test-password',
  MQTT_ENABLED: 'false',
});

const { handleMqttMessage } = await import('../src/ingestion/handlers.js');

const deviceId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const commandId = '33333333-3333-4333-8333-333333333333';
const timestamp = '2026-10-20T12:00:00.000Z';

function validStatusPayload() {
  return {
    tds: 42,
    tank_level_ml: 2_500,
    filter_life_liters: 100,
    status: 'online' as const,
    firmware_version: '1.4.2',
    ts: timestamp,
  };
}

function validSessionPayload() {
  return {
    id: sessionId,
    user_id: '44444444-4444-4444-8444-444444444444',
    start_ts: timestamp,
    end_ts: '2026-10-20T12:02:00.000Z',
    volume_ml: 750,
    avg_tds_out: 18,
    temperature_c: 21.5,
  };
}

function validCommandAckPayload() {
  return {
    command_id: commandId,
    status: 'completed' as const,
  };
}

type RecordedCall = {
  operation: 'select' | 'update' | 'eq' | 'upsert';
  table: string;
  value?: unknown;
  column?: string;
  values?: unknown;
  options?: unknown;
};

type QueryResult = { data: unknown; error: null };

class FakeQuery {
  public constructor(
    private readonly table: string,
    private readonly calls: RecordedCall[],
  ) {}

  public select(value: string) {
    this.calls.push({ operation: 'select', table: this.table, value });
    return this;
  }

  public update(values: unknown) {
    this.calls.push({ operation: 'update', table: this.table, values });
    return this;
  }

  public eq(column: string, value: unknown) {
    this.calls.push({ operation: 'eq', table: this.table, column, value });
    return this;
  }

  public in(column: string, value: unknown) {
    this.calls.push({ operation: 'eq', table: this.table, column, value });
    return this;
  }

  public upsert(values: unknown, options: unknown) {
    this.calls.push({ operation: 'upsert', table: this.table, values, options });
    return Promise.resolve({ error: null });
  }

  public maybeSingle(): Promise<QueryResult> {
    return Promise.resolve(this.result());
  }

  // Supabase query builders are awaitable. This lets the fake support the
  // update(...).eq(...) calls without implementing a network client.
  public then(onFulfilled: (result: QueryResult) => unknown) {
    return Promise.resolve(this.result()).then(onFulfilled);
  }

  private result(): QueryResult {
    if (this.table === 'devices') {
      return { data: { id: deviceId }, error: null };
    }
    if (this.table === 'command_logs') {
      return { data: { id: commandId }, error: null };
    }
    return { data: [], error: null };
  }
}

function createContext() {
  const calls: RecordedCall[] = [];
  const warnings: unknown[][] = [];
  const supabase = {
    from(table: string) {
      return new FakeQuery(table, calls);
    },
  } as unknown as SupabaseClient;
  const logger = {
    warn(...args: unknown[]) {
      warnings.push(args);
    },
    info() {},
    error() {},
  } as unknown as FastifyBaseLogger;

  return {
    context: { supabase, logger },
    calls,
    warnings,
  };
}

function callsFor(calls: RecordedCall[], operation: RecordedCall['operation'], table: string) {
  return calls.filter((call) => call.operation === operation && call.table === table);
}

test('accepts valid status, session, and command-ack payloads', () => {
  const status = statusPayloadSchema.safeParse(validStatusPayload());
  assert.equal(status.success, true);
  if (status.success) {
    assert.deepEqual(status.data, validStatusPayload());
  }

  const session = sessionPayloadSchema.safeParse(validSessionPayload());
  assert.equal(session.success, true);
  if (session.success) {
    assert.deepEqual(session.data, validSessionPayload());
  }

  const commandAck = commandAckPayloadSchema.safeParse(validCommandAckPayload());
  assert.equal(commandAck.success, true);
  if (commandAck.success) {
    assert.deepEqual(commandAck.data, validCommandAckPayload());
  }
});

test('rejects invalid UUIDs, missing required fields, and out-of-range values', () => {
  assert.equal(deviceIdSchema.safeParse('not-a-uuid').success, false);
  assert.equal(
    sessionPayloadSchema.safeParse({ ...validSessionPayload(), id: 'not-a-uuid' }).success,
    false,
  );
  assert.equal(
    commandAckPayloadSchema.safeParse({ ...validCommandAckPayload(), command_id: 'not-a-uuid' }).success,
    false,
  );

  assert.equal(statusPayloadSchema.safeParse({ ...validStatusPayload(), tds: undefined }).success, false);
  assert.equal(sessionPayloadSchema.safeParse({ ...validSessionPayload(), end_ts: undefined }).success, false);
  assert.equal(commandAckPayloadSchema.safeParse({ ...validCommandAckPayload(), status: undefined }).success, false);

  assert.equal(statusPayloadSchema.safeParse({ ...validStatusPayload(), tank_level_ml: -1 }).success, false);
  assert.equal(sessionPayloadSchema.safeParse({ ...validSessionPayload(), volume_ml: 0 }).success, false);
});

test('handles a valid status payload through an in-memory Supabase boundary', async () => {
  const { context, calls } = createContext();

  await handleMqttMessage(
    context,
    `telemetry/status/${deviceId}`,
    Buffer.from(JSON.stringify(validStatusPayload())),
  );

  const updates = callsFor(calls, 'update', 'devices');
  assert.equal(updates.length, 1);
  const values = updates[0]?.values as Record<string, unknown>;
  assert.deepEqual(
    {
      current_tds: values.current_tds,
      tank_level_ml: values.tank_level_ml,
      status: values.status,
      filter_life_liters: values.filter_life_liters,
      firmware_version: values.firmware_version,
    },
    {
      current_tds: 42,
      tank_level_ml: 2_500,
      status: 'online',
      filter_life_liters: 100,
      firmware_version: '1.4.2',
    },
  );
  assert.equal(typeof values.last_seen_at, 'string');
});

test('uses the session UUID and ignore-duplicates upsert contract on retries', async () => {
  const { context, calls } = createContext();
  const payload = validSessionPayload();

  await handleMqttMessage(
    context,
    `telemetry/sessions/${deviceId}`,
    Buffer.from(JSON.stringify(payload)),
  );
  await handleMqttMessage(
    context,
    `telemetry/sessions/${deviceId}`,
    Buffer.from(JSON.stringify(payload)),
  );

  const upserts = callsFor(calls, 'upsert', 'dispense_sessions');
  assert.equal(upserts.length, 2);
  for (const upsert of upserts) {
    assert.deepEqual(upsert.values, {
      id: sessionId,
      device_id: deviceId,
      user_id: '44444444-4444-4444-8444-444444444444',
      start_ts: timestamp,
      end_ts: '2026-10-20T12:02:00.000Z',
      volume_ml: 750,
      avg_tds_out: 18,
      temperature_c: 21.5,
    });
    assert.deepEqual(upsert.options, { onConflict: 'id', ignoreDuplicates: true });
  }
});

test('handles a valid command acknowledgement payload', async () => {
  const { context, calls } = createContext();

  await handleMqttMessage(
    context,
    `device/${deviceId}/command_ack`,
    Buffer.from(JSON.stringify(validCommandAckPayload())),
  );

  const updates = callsFor(calls, 'update', 'command_logs');
  assert.equal(updates.length, 1);
  const values = updates[0]?.values as Record<string, unknown>;
  assert.equal(values.status, 'completed');
  assert.equal(typeof values.updated_at, 'string');
  assert.deepEqual(
    callsFor(calls, 'eq', 'command_logs').map((call) => [call.column, call.value]),
    [
      ['id', commandId],
      ['device_id', deviceId],
      ['status', ['pending', 'delivered']],
    ],
  );
});

test('does not throw or touch Supabase for malformed JSON', async () => {
  const { context, calls, warnings } = createContext();

  await assert.doesNotReject(() =>
    handleMqttMessage(
      context,
      `telemetry/status/${deviceId}`,
      Buffer.from('{ definitely not JSON'),
    ),
  );

  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[1]), /malformed MQTT JSON/);
});

test('ignores malformed topic UUIDs and required fields before database access', async () => {
  const { context, calls, warnings } = createContext();

  await handleMqttMessage(
    context,
    'telemetry/status/not-a-uuid',
    Buffer.from(JSON.stringify(validStatusPayload())),
  );
  await handleMqttMessage(
    context,
    `telemetry/sessions/${deviceId}`,
    Buffer.from(JSON.stringify({ ...validSessionPayload(), end_ts: undefined })),
  );

  assert.equal(calls.length, 0);
  assert.equal(warnings.length, 2);
});
