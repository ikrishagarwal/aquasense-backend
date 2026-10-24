import fp from 'fastify-plugin';
import { setTimeout as delay } from 'node:timers/promises';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { config } from '../config.js';
import { AppError } from '../lib/errors.js';
import { handleMqttMessage } from '../ingestion/handlers.js';

export interface MqttService {
  publish(topic: string, payload: string | Record<string, unknown>): Promise<void>;
  isConnected(): boolean;
  close(): Promise<void>;
}

const subscriptions = [
  'telemetry/status/+',
  'telemetry/sessions/+',
  'device/+/command_ack',
];

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

  const service: MqttService = {
    publish(topic, payload) {
      if (!client || !connected) {
        return Promise.reject(new AppError(503, 'MQTT_UNAVAILABLE', 'The MQTT broker is not connected'));
      }

      const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
      return new Promise<void>((resolve, reject) => {
        client?.publish(topic, message, { qos: 1 }, (error) => {
          if (error) {
            reject(new AppError(503, 'MQTT_PUBLISH_FAILED', 'Unable to publish the device command', error.message));
            return;
          }
          resolve();
        });
      });
    },

    isConnected() {
      return connected;
    },

    close() {
      connected = false;
      if (!client) {
        return Promise.resolve();
      }
      const currentClient = client;
      client = null;
      return new Promise<void>((resolve) => {
        currentClient.end(false, {}, () => resolve());
      });
    },
  };

  app.decorate('mqtt', service);

  if (!config.MQTT_ENABLED) {
    app.log.warn('MQTT is disabled by configuration');
    return;
  }

  app.addHook('onReady', async () => {
    const options: IClientOptions = {
      username: config.MQTT_USERNAME,
      password: config.MQTT_PASSWORD,
      reconnectPeriod: 5_000,
      connectTimeout: 10_000,
    };
    client = mqtt.connect(config.MQTT_URL, options);

    client.on('connect', () => {
      connected = true;
      app.log.info({ subscriptions }, 'Connected to MQTT broker');
      client?.subscribe(subscriptions, { qos: 1 }, (error) => {
        if (error) {
          app.log.error({ error }, 'Unable to subscribe to MQTT topics');
        }
      });
    });
    client.on('reconnect', () => {
      connected = false;
      app.log.info('Reconnecting to MQTT broker');
    });
    client.on('close', () => {
      connected = false;
      app.log.info('MQTT connection closed');
    });
    client.on('error', (error) => {
      connected = false;
      app.log.error({ error }, 'MQTT client error');
    });
    client.on('message', (topic, payload) => {
      void processMessageWithRetry(() => handleMqttMessage({ supabase: app.supabase, logger: app.log }, topic, payload))
        .catch((error: unknown) => app.log.error({ error, topic }, 'MQTT message processing failed'));
    });
  });

  app.addHook('onClose', async () => {
    await service.close();
  });
});
