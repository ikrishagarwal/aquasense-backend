import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';
import { deviceIdSchema } from '../src/ingestion/schemas.js';

const { MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, MQTT_CA_PATH, DEVICE_ID } = process.env;
const deviceId = deviceIdSchema.parse(DEVICE_ID);
if (!MQTT_URL?.startsWith('mqtts://') || !MQTT_USERNAME || !MQTT_PASSWORD) {
  throw new Error('MQTT_URL (mqtts://), MQTT_USERNAME, and MQTT_PASSWORD are required');
}

const envelope = { schema_version: 1, device_id: deviceId };
const prefix = `purifier/${deviceId}`;
const client = mqtt.connect(MQTT_URL, {
  username: MQTT_USERNAME, password: MQTT_PASSWORD, rejectUnauthorized: true,
  ...(MQTT_CA_PATH ? { ca: readFileSync(MQTT_CA_PATH) } : {}),
  will: { topic: `${prefix}/status`, payload: JSON.stringify({ ...envelope, status: 'offline' }), qos: 1, retain: true },
});
const pending = new Map<string, { channel: 'events' | 'ack'; payload: object }>();
const commands = new Map<string, object[]>();

function tick() {
  if (!client.connected) return;
  const timestamp = new Date().toISOString();
  client.publish(`${prefix}/telemetry`, JSON.stringify({
    ...envelope, timestamp, tank_state: 'UNKNOWN', sensors: {},
    health: {
      core_rss_kib: null, cpu_temperature_c: null, disk_free_bytes: null, writer_depth: 0,
      storage_healthy: true, throttling: null, vision: 'disabled', mqtt: 'connected',
      pending_outbox: pending.size, sqlite_integrity: null,
    },
  }), { qos: 0 });
  if (pending.size < 100) {
    const eventId = randomUUID();
    pending.set(`${eventId}:1`, { channel: 'events', payload: {
      ...envelope, event_id: eventId, revision: 1, user_id: 'guest',
      start_ts: timestamp, end_ts: timestamp, volume_ml: 250.25, pulse_count: 25,
      temperature_c: null, tds_in: null, tds_out: null, ph_approx: null,
      sensor_quality: {
        temperature_c: 'sensor_error', tds_in: 'sensor_error', tds_out: 'sensor_error', ph_approx: 'sensor_error',
      },
      confidence: null, recognition_status: 'disabled', volume_quality: 'uncalibrated',
      incomplete: false, quality_flags: [],
    } });
  }
  resend();
}

function resend() {
  for (const { channel, payload } of pending.values()) {
    client.publish(`${prefix}/${channel}`, JSON.stringify(payload), { qos: 1 });
  }
}

client.on('connect', () => {
  client.subscribe([`${prefix}/cmd`, `${prefix}/events_ack`], { qos: 1 }, error => {
    if (error) return console.error('Mock Pi subscription failed');
    client.publish(`${prefix}/status`, JSON.stringify({ ...envelope, status: 'online' }), { qos: 1, retain: true });
    tick();
  });
});
client.on('error', error => console.error(error.message));
client.on('message', (topic, payload, packet) => {
  let message;
  try { message = JSON.parse(payload.toString()); } catch { return; }
  if (!message || message.device_id !== deviceId || message.schema_version !== 1) return;
  if (topic === `${prefix}/events_ack` && message.status === 'committed') {
    pending.delete(`${message.event_id}:${message.revision}`);
  }
  if (topic !== `${prefix}/cmd` || packet.retain || message.type !== 'drain'
    || !deviceIdSchema.safeParse(message.command_id).success) return;
  const now = Date.now();
  const issued = Date.parse(message.issued_at);
  const expires = Date.parse(message.expires_at);
  if (!(issued <= now && now < expires && expires - issued <= 30_000)
    || typeof message.duration_s !== 'number' || !(message.duration_s > 0 && message.duration_s <= 15)) return;
  const id = message.command_id;
  if (!commands.has(id)) {
    const timestamp = new Date().toISOString();
    commands.set(id, ['received', 'rejected'].map((status, index) => ({
      ...envelope, event_id: id, command_id: id, revision: index + 1, type: 'command_ack',
      status, reason: 'actuation_disabled', timestamp, valve_state: 'commanded_closed',
    })));
  }
  commands.get(id)?.forEach((entry, index) => pending.set(`${id}:${index + 1}`, { channel: 'ack', payload: entry }));
  resend();
});
const timer = setInterval(tick, Number(process.env.MOCK_RPI_INTERVAL_MS ?? 5000));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(timer);
    if (!client.connected) return client.end(true);
    client.publish(`${prefix}/status`, JSON.stringify({ ...envelope, status: 'offline' }), { qos: 1, retain: true },
      () => client.end());
  });
}
