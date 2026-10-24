import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

const mqttUrl = process.env.MQTT_URL;
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;
const deviceId = process.env.DEVICE_ID;
const intervalMs = Number(process.env.MOCK_RPI_INTERVAL_MS ?? 5_000);

if (!mqttUrl || !username || !password || !deviceId) {
  throw new Error('MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, and DEVICE_ID are required');
}

const client = mqtt.connect(mqttUrl, {
  username,
  password,
  reconnectPeriod: 5_000,
});

let tankLevel = 2_500;
let filterLife = 800;

function publishStatus() {
  const payload = {
    tds: 35 + Math.floor(Math.random() * 15),
    tank_level_ml: tankLevel,
    filter_life_liters: filterLife,
    status: 'online',
    firmware_version: 'mock-1.0.0',
    ts: new Date().toISOString(),
  };
  client.publish(`telemetry/status/${deviceId}`, JSON.stringify(payload), { qos: 1 });
}

function publishSession() {
  const start = new Date(Date.now() - 2_000);
  const end = new Date();
  const payload = {
    id: randomUUID(),
    start_ts: start.toISOString(),
    end_ts: end.toISOString(),
    volume_ml: 250,
    avg_tds_out: 18,
    temperature_c: 22,
  };
  tankLevel = Math.max(0, tankLevel - payload.volume_ml);
  filterLife = Math.max(0, filterLife - 0.25);
  client.publish(`telemetry/sessions/${deviceId}`, JSON.stringify(payload), { qos: 1 });
}

client.on('connect', () => {
  console.log(`Mock RPi connected for device ${deviceId}`);
  publishStatus();
  const timer = setInterval(() => {
    publishStatus();
    publishSession();
  }, intervalMs);

  const stop = () => {
    clearInterval(timer);
    client.end(false, {}, () => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
});

client.on('error', (error) => {
  console.error('Mock RPi MQTT error:', error.message);
});
