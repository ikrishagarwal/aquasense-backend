import { z } from 'zod';

export const deviceIdSchema = z.string().uuid();
export const mqttTimestampSchema = z.string().datetime({ offset: true });

export const statusPayloadSchema = z.object({
  tds: z.number().int().nonnegative(),
  tank_level_ml: z.number().int().nonnegative(),
  filter_life_liters: z.number().nonnegative().optional(),
  status: z.enum(['offline', 'online', 'dispensing', 'flushing']),
  firmware_version: z.string().min(1).optional(),
  ts: mqttTimestampSchema,
});

export const sessionPayloadSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid().optional(),
  start_ts: mqttTimestampSchema,
  end_ts: mqttTimestampSchema,
  volume_ml: z.number().int().positive(),
  avg_tds_out: z.number().int().nonnegative().optional(),
  temperature_c: z.number().finite().optional(),
});

export const commandAckPayloadSchema = z.object({
  command_id: z.string().uuid(),
  status: z.enum(['completed', 'failed']),
});

export type StatusPayload = z.infer<typeof statusPayloadSchema>;
export type SessionPayload = z.infer<typeof sessionPayloadSchema>;
export type CommandAckPayload = z.infer<typeof commandAckPayloadSchema>;

export function parseMqttPayload(payload: Buffer): unknown {
  return JSON.parse(payload.toString('utf8')) as unknown;
}
