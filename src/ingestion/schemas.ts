import { z } from 'zod';

export const deviceIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export const mqttTimestampSchema = z.iso.datetime({ offset: true }).regex(/(?:Z|\+00:00)$/);
const envelope = { schema_version: z.literal(1), device_id: deviceIdSchema };
const event = { ...envelope, event_id: deviceIdSchema, revision: z.number().int().min(1).max(2147483647) };
const quality = z.enum(['valid', 'stale', 'uncalibrated', 'out_of_range', 'sensor_error']);
const timestamp = mqttTimestampSchema;
const label = z.string().min(1).max(128);
const count = z.number().int().nonnegative();
const sensorFields = ['temperature_c', 'tds_in', 'tds_out', 'ph_approx'] as const;

export const sessionPayloadSchema = z.strictObject({
  ...event,
  user_id: z.union([z.literal('guest'), deviceIdSchema]),
  start_ts: timestamp,
  end_ts: timestamp,
  volume_ml: z.number().nonnegative(),
  pulse_count: count,
  temperature_c: z.number().nullable(),
  tds_in: z.number().nullable(),
  tds_out: z.number().nullable(),
  ph_approx: z.number().nullable(),
  sensor_quality: z.strictObject({ temperature_c: quality, tds_in: quality, tds_out: quality, ph_approx: quality }),
  confidence: z.number().nullable(),
  recognition_status: label,
  volume_quality: z.enum(['measured', 'uncalibrated']),
  incomplete: z.boolean(),
  quality_flags: z.array(label),
}).refine(value => Date.parse(value.end_ts) >= Date.parse(value.start_ts)
  && sensorFields.every(field => (value[field] !== null) === (value.sensor_quality[field] === 'valid')));

export const alertPayloadSchema = z.strictObject({
  ...event, type: z.literal('alert'), name: label, active: z.boolean(), timestamp,
});
export const eventsPayloadSchema = z.union([sessionPayloadSchema, alertPayloadSchema]);
export const lifecycleStatus = z.enum(['received', 'accepted', 'rejected', 'running', 'completed', 'failed']);
export const commandAckPayloadSchema = z.strictObject({
  ...event, type: z.literal('command_ack'), command_id: deviceIdSchema,
  status: lifecycleStatus, reason: z.string().max(256), timestamp,
  valve_state: z.enum(['commanded_open', 'commanded_closed']),
}).refine(value => value.event_id === value.command_id);
export const statusPayloadSchema = z.strictObject({
  ...envelope, status: z.enum(['online', 'offline']),
});
const reading = z.strictObject({
  timestamp, quality, value: z.number().nullable(), unit: label,
}).refine(value => (value.value !== null) === (value.quality === 'valid'));
export const tankState = z.enum(['LOW', 'OK', 'UNKNOWN']);
export const telemetryPayloadSchema = z.strictObject({
  ...envelope, timestamp, tank_state: tankState,
  sensors: z.strictObject({
    temperature_c: reading.optional(), tds_in: reading.optional(),
    tds_out: reading.optional(), ph_approx: reading.optional(),
  }),
  health: z.strictObject({
    core_rss_kib: count.nullable(), cpu_temperature_c: z.number().nullable(),
    disk_free_bytes: count.nullable(), writer_depth: count,
    storage_healthy: z.boolean(), throttling: count.nullable(),
    vision: label, mqtt: label, pending_outbox: count, sqlite_integrity: label.nullable(),
  }),
});

export function parseMqttPayload(payload: Buffer): unknown {
  if (payload.length > 16_384) throw new Error('Payload too large');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
}
