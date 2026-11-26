import { readFileSync } from 'node:fs';
import fp from 'fastify-plugin';
import { setTimeout as delay } from 'node:timers/promises';
import mqtt, { type IClientOptions, type MqttClient, type Packet } from 'mqtt';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { handleMqttMessage } from '../ingestion/handlers.js';

export interface MqttService {
  publish(topic: string, payload: string | Record<string, unknown>, expiresAt?: number): Promise<void>;
  isConnected(): boolean;
  close(): Promise<void>;
}

const reliableSubscriptions = ['purifier/+/events', 'purifier/+/ack', 'purifier/+/status'];

async function processMessageWithRetry(
  processMessage: () => Promise<void>,
  attempts = 3,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await processMessage();
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) {
        await delay(100 * (2 ** attempt));
      }
    }
  }
  throw lastError;
}

export default fp(async (app) => {
  let client: MqttClient | null = null;
  let connected = false;
  const inflight = new Map<Buffer, { id?: number; cancel: () => void }>();

  const service: MqttService = {
    publish(topic, payload, expiresAt) {
      const publisher = client;
      const timeout = Math.min(2_000, (expiresAt ?? Infinity) - Date.now());
      if (!publisher || !connected || !publisher.connected || inflight.size >= 1024 || timeout <= 0) {
        return Promise.reject(new AppError(503, 'MQTT_UNAVAILABLE', 'MQTT publish is unavailable or expired'));
      }

      const message = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      return new Promise<void>((resolve, reject) => {
        const cancel = () => {
          const id = inflight.get(message)?.id;
          if (id !== undefined) publisher.removeOutgoingMessage(id);
          finish(new Error('MQTT publish interrupted'));
        };
        const timer = setTimeout(cancel, timeout);
        const finish = (error?: Error | null) => {
          clearTimeout(timer);
          inflight.delete(message);
          if (error) reject(new AppError(503, 'MQTT_PUBLISH_FAILED', 'MQTT publish failed'));
          else resolve();
        };
        inflight.set(message, { cancel });
        publisher.publish(topic, message, { qos: 1, retain: false }, finish);
      });
    },

    isConnected() {
      return connected && client?.connected === true;
    },

    close() {
      connected = false;
      if (!client) {
        return Promise.resolve();
      }
      const currentClient = client;
      client = null;
      return new Promise<void>((resolve) => {
        currentClient.end(true, {}, () => resolve());
      });
    },
  };

  app.decorate('mqtt', service);

  if (!config.MQTT_ENABLED) {
    app.log.warn('MQTT is disabled by configuration');
    return;
  }
  const brokerUrl = config.MQTT_URL;
  if (!brokerUrl) throw Error('MQTT_URL is required when MQTT is enabled');

  app.addHook('onReady', async () => {
    const options: IClientOptions = {
      rejectUnauthorized: true,
      ...(config.MQTT_CA_PATH ? { ca: readFileSync(config.MQTT_CA_PATH) } : {}),
      username: config.MQTT_USERNAME,
      password: config.MQTT_PASSWORD,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
    };
    client = mqtt.connect(brokerUrl, options);

    client.on('connect', () => {
      connected = false;
      client?.subscribe(reliableSubscriptions, { qos: 1 }, (error, grants) => {
        if (error || grants?.length !== reliableSubscriptions.length || grants.some(grant => grant.qos !== 1)) {
          app.log.error('Reliable MQTT subscription failed');
        } else {
          connected = client?.connected === true;
          app.log.info('MQTT reliable subscriptions ready');
        }
      });
      client?.subscribe('purifier/+/telemetry', { qos: 0 }, (error, grants) => {
        if (error || grants?.[0]?.qos !== 0) app.log.error('MQTT telemetry subscription failed');
      });
    });
    client.on('reconnect', () => {
      connected = false;
      app.log.info('Reconnecting to MQTT broker');
    });
    client.on('packetsend', (packet: Packet) => {
      if (packet.cmd === 'publish' && Buffer.isBuffer(packet.payload)) {
        const pending = inflight.get(packet.payload);
        if (pending) pending.id = packet.messageId;
      }
    });
    client.on('close', () => {
      connected = false;
      for (const pending of inflight.values()) pending.cancel();
      app.log.info('MQTT connection closed');
    });
    client.on('error', (error) => {
      connected = false;
      app.log.error({ error }, 'MQTT client error');
    });
    const context = {
      supabase: app.supabase,
      logger: app.log,
      publishCommitAck: (deviceId: string, eventId: string, revision: number) =>
        service.publish(`purifier/${deviceId}/events_ack`, {
          schema_version: 1, device_id: deviceId, event_id: eventId, revision, status: 'committed',
        }),
    };
    // Untimestamped online/LWT messages must be applied in broker delivery order.
    let availability = Promise.resolve();
    client.on('message', (topic, payload) => {
      const process = () => processMessageWithRetry(() => handleMqttMessage(context, topic, payload))
        .catch(() => app.log.error('MQTT message processing or commit ACK failed'));
      if (topic.endsWith('/status')) availability = availability.then(process);
      else void process();
    });
  });

  app.addHook('onClose', async () => {
    await service.close();
  });
});
