import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';
import { commandAckPayloadSchema, deviceIdSchema, eventsPayloadSchema,
  parseMqttPayload, statusPayloadSchema, telemetryPayloadSchema } from './schemas.js';

interface MessageContext {
  supabase: SupabaseClient;
  logger: FastifyBaseLogger;
  publishCommitAck: (deviceId: string, eventId: string, revision: number) => Promise<void>;
}

const schemas = {
  events: eventsPayloadSchema,
  telemetry: telemetryPayloadSchema,
  ack: commandAckPayloadSchema,
  status: statusPayloadSchema,
};

export async function handleMqttMessage(context: MessageContext, topic: string, rawPayload: Buffer) {
  const match = /^purifier\/([^/]+)\/(events|telemetry|ack|status)$/.exec(topic);
  if (!match || !deviceIdSchema.safeParse(match[1]).success) return;
  const deviceId = match[1];
  const channel = match[2] as keyof typeof schemas;
  let message: unknown;
  try {
    message = parseMqttPayload(rawPayload);
  } catch {
    context.logger.warn({ deviceId, channel }, 'Invalid MQTT encoding or payload size');
    return;
  }

  if (channel === 'status') {
    const { data } = statusPayloadSchema.safeParse(message);
    if (data?.device_id === deviceId) {
      const { error } = await context.supabase.from('devices')
        .update({ status: data.status, last_seen_at: new Date().toISOString() }).eq('id', deviceId);
      if (error) throw new Error('Availability write failed');
      return;
    }
  } else if (channel === 'telemetry') {
    const { data } = telemetryPayloadSchema.safeParse(message);
    if (data?.device_id === deviceId) {
      const { error } = await context.supabase.from('devices').update({
        tank_state: data.tank_state, telemetry: data, last_telemetry_at: data.timestamp,
        last_seen_at: new Date().toISOString(),
      }).eq('id', deviceId).or(`last_telemetry_at.is.null,last_telemetry_at.lt.${data.timestamp}`);
      if (error) throw new Error('Telemetry write failed');
      return;
    }
  } else {
    const { data } = schemas[channel].safeParse(message);
    if (data?.device_id === deviceId) {
      const kind = 'type' in data ? data.type : 'dispense';
      const { data: result, error } = await context.supabase.rpc('commit_edge_event', {
        p_kind: kind, p_payload: data,
      });
      if (error) throw new Error('Event transaction failed');
      if (result === 'committed') {
        await context.publishCommitAck(deviceId, data.event_id, data.revision);
      } else {
        context.logger.warn({ deviceId, channel, eventId: data.event_id, result }, 'MQTT event rejected');
      }
      return;
    }
  }
  context.logger.warn({ deviceId, channel }, 'Invalid MQTT payload or mismatched device');
}
