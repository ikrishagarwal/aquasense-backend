import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.string().default('info'),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  MQTT_URL: z.string().optional(),
  MQTT_USERNAME: z.string().optional(),
  MQTT_PASSWORD: z.string().optional(),
  MQTT_ENABLED: z.enum(['true', 'false']).default('true').transform((value) => value === 'true'),
  AQUASENSE_DEVICE_TOKENS: z.string().default('{}').transform((value, ctx) => {
    try {
      const tokens = z.record(z.uuid(), z.string().regex(/^[A-Za-z0-9._~+/-]+=*$/)).parse(JSON.parse(value));
      const entries = Object.entries(tokens).map(([id, token]) => [id.toLowerCase(), token] as const);
      const mapping = new Map(entries);
      if (mapping.size === entries.length && new Set(mapping.values()).size === mapping.size) {
        return mapping;
      }
    } catch {
      // Configuration diagnostics must never contain tokens.
    }
    ctx.addIssue({ code: 'custom', message: 'Expected a JSON object mapping device UUIDs to distinct bearer tokens' });
    return z.NEVER;
  }),
  DEVICE_ONLINE_WINDOW_MINUTES: z.coerce.number().positive().default(5),
  COMMAND_RATE_LIMIT_MS: z.coerce.number().int().nonnegative().default(10_000),
  DRAIN_MAX_DURATION_S: z.coerce.number().positive().max(15).default(15),
  MQTT_CA_PATH: z.string().optional(),
  FCM_SERVICE_ACCOUNT_PATH: z.string().optional(),
}).superRefine((env, ctx) => {
  if (!env.MQTT_ENABLED) return;
  if (!env.MQTT_URL?.startsWith('mqtts://')) {
    ctx.addIssue({ code: 'custom', path: ['MQTT_URL'], message: 'MQTT requires a verified mqtts:// connection' });
  }
  for (const field of ['MQTT_USERNAME', 'MQTT_PASSWORD'] as const) {
    if (!env[field]) ctx.addIssue({ code: 'custom', path: [field], message: 'Required when MQTT is enabled' });
  }
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
