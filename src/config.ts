import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  MQTT_URL: z.string().min(1),
  MQTT_USERNAME: z.string().min(1),
  MQTT_PASSWORD: z.string().min(1),
  MQTT_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  DEVICE_ONLINE_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  COMMAND_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(10_000),
  DRAIN_MAX_DURATION_S: z.coerce.number().positive().max(15).default(15),
  MQTT_CA_PATH: z.string().optional(),
  FCM_SERVICE_ACCOUNT_PATH: z.string().optional(),
}).refine(env => !env.MQTT_ENABLED || /^mqtts:\/\//.test(env.MQTT_URL), {
  path: ['MQTT_URL'], message: 'MQTT requires a verified mqtts:// connection',
});

export type AppConfig = z.infer<typeof envSchema>;

function loadConfig(): AppConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error('Invalid environment configuration:');
    for (const [field, errors] of Object.entries(parsed.error.flatten().fieldErrors)) {
      console.error(`  ${field}: ${(errors ?? []).join(', ')}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadConfig();
