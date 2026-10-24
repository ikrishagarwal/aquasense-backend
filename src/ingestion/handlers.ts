import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';
import {
  commandAckPayloadSchema,
  deviceIdSchema,
  parseMqttPayload,
  sessionPayloadSchema,
  statusPayloadSchema,
  type CommandAckPayload,
  type SessionPayload,
  type StatusPayload,
} from './schemas.js';
import { config } from '../config.js';
import { notifyMembers } from '../lib/fcm.js';

interface MessageContext {
  supabase: SupabaseClient;
  logger: FastifyBaseLogger;
}

interface KnownDevice {
  id: string;
  last_telemetry_at?: string | null;
}

const alertState = new Map<string, boolean>();

function topicDeviceId(topic: string, prefix: string): string | null {
  const value = topic.slice(prefix.length);
  const parsed = deviceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function knownDevice(
  supabase: SupabaseClient,
  deviceId: string,
  logger: FastifyBaseLogger,
): Promise<KnownDevice | null> {
  const { data, error } = await supabase
    .from('devices')
    .select('id, last_telemetry_at')
    .eq('id', deviceId)
    .maybeSingle();

  if (error) {
    throw new Error(`Unable to verify device ${deviceId}: ${error.message}`);
  }
  if (!data) {
    logger.warn({ deviceId }, 'Ignoring MQTT message for an unknown device');
    return null;
  }
  return data as KnownDevice;
}

async function alertOnThreshold(
  context: MessageContext,
  deviceId: string,
  alertType: 'filter_life_low' | 'tank_level_low',
  isBelowThreshold: boolean,
  message: string,
): Promise<void> {
  const stateKey = `${deviceId}:${alertType}`;
  const wasBelowThreshold = alertState.get(stateKey) ?? false;
  alertState.set(stateKey, isBelowThreshold);
  if (isBelowThreshold && !wasBelowThreshold) {
    await notifyMembers(context.supabase, deviceId, {
      type: alertType,
      message,
    }, context.logger);
  }
}

async function handleStatus(
  context: MessageContext,
  deviceId: string,
  payload: StatusPayload,
): Promise<void> {
  const device = await knownDevice(context.supabase, deviceId, context.logger);
  if (!device) {
    return;
  }

  const incomingTelemetryAt = new Date(payload.ts).getTime();
  const previousTelemetryAt = device.last_telemetry_at ? new Date(device.last_telemetry_at).getTime() : Number.NaN;
  if (Number.isFinite(previousTelemetryAt) && incomingTelemetryAt <= previousTelemetryAt) {
    context.logger.warn({ deviceId, telemetryAt: payload.ts }, 'Ignoring stale MQTT status message');
    return;
  }

  const updates: Record<string, unknown> = {
    current_tds: payload.tds,
    tank_level_ml: payload.tank_level_ml,
    status: payload.status,
    last_seen_at: new Date().toISOString(),
    last_telemetry_at: payload.ts,
  };
  if (payload.filter_life_liters !== undefined) {
    updates.filter_life_liters = payload.filter_life_liters;
  }
  if (payload.firmware_version !== undefined) {
    updates.firmware_version = payload.firmware_version;
  }

  const { error } = await context.supabase
    .from('devices')
    .update(updates)
    .eq('id', deviceId);
  if (error) {
    throw new Error(`Unable to update device status: ${error.message}`);
  }

  if (payload.filter_life_liters !== undefined) {
    await alertOnThreshold(
      context,
      deviceId,
      'filter_life_low',
      payload.filter_life_liters <= config.FILTER_ALERT_THRESHOLD_LITERS,
      `Filter life is low (${payload.filter_life_liters} L remaining)`,
    );
  }
  await alertOnThreshold(
    context,
    deviceId,
    'tank_level_low',
    payload.tank_level_ml <= config.TANK_ALERT_THRESHOLD_ML,
    `Tank level is low (${payload.tank_level_ml} ml remaining)`,
  );
}

async function handleSession(
  context: MessageContext,
  deviceId: string,
  payload: SessionPayload,
): Promise<void> {
  if (!(await knownDevice(context.supabase, deviceId, context.logger))) {
    return;
  }

  let userId = payload.user_id ?? null;
  if (userId) {
    const { data: membership, error: membershipError } = await context.supabase
      .from('device_members')
      .select('user_id')
      .eq('device_id', deviceId)
      .eq('user_id', userId)
      .maybeSingle();
    if (membershipError) {
      throw new Error(`Unable to verify session member: ${membershipError.message}`);
    }
    if (!membership) {
      context.logger.warn({ deviceId, userId }, 'Storing a session with an unknown user as a guest');
      userId = null;
    }
  }

  const { error } = await context.supabase
    .from('dispense_sessions')
    .upsert({
      id: payload.id,
      device_id: deviceId,
      user_id: userId,
      start_ts: payload.start_ts,
      end_ts: payload.end_ts,
      volume_ml: payload.volume_ml,
      avg_tds_out: payload.avg_tds_out ?? null,
      temperature_c: payload.temperature_c ?? null,
    }, { onConflict: 'id', ignoreDuplicates: true });
  if (error) {
    throw new Error(`Unable to insert dispense session: ${error.message}`);
  }
}

async function handleCommandAck(
  context: MessageContext,
  deviceId: string,
  payload: CommandAckPayload,
): Promise<void> {
  const { data, error } = await context.supabase
    .from('command_logs')
    .update({ status: payload.status, updated_at: new Date().toISOString() })
    .eq('id', payload.command_id)
    .eq('device_id', deviceId)
    .in('status', ['pending', 'delivered'])
    .select('id')
    .maybeSingle();
  if (error) {
    throw new Error(`Unable to update command acknowledgement: ${error.message}`);
  }
  if (!data) {
    context.logger.warn({ deviceId, commandId: payload.command_id }, 'Received ACK for an unknown command');
  }
}

export async function handleMqttMessage(
  context: MessageContext,
  topic: string,
  rawPayload: Buffer,
): Promise<void> {
  let message: unknown;
  try {
    message = parseMqttPayload(rawPayload);
  } catch {
    context.logger.warn({ topic, payload: rawPayload.toString('utf8').slice(0, 2048) }, 'Ignoring malformed MQTT JSON');
    return;
  }

  if (topic.startsWith('telemetry/status/')) {
    const deviceId = topicDeviceId(topic, 'telemetry/status/');
    const parsed = statusPayloadSchema.safeParse(message);
    if (!deviceId || !parsed.success) {
      context.logger.warn({ topic }, 'Ignoring malformed MQTT status message');
      return;
    }
    await handleStatus(context, deviceId, parsed.data);
    return;
  }

  if (topic.startsWith('telemetry/sessions/')) {
    const deviceId = topicDeviceId(topic, 'telemetry/sessions/');
    const parsed = sessionPayloadSchema.safeParse(message);
    if (!deviceId || !parsed.success) {
      context.logger.warn({ topic }, 'Ignoring malformed MQTT session message');
      return;
    }
    await handleSession(context, deviceId, parsed.data);
    return;
  }

  if (topic.startsWith('device/') && topic.endsWith('/command_ack')) {
    const topicMatch = /^device\/([^/]+)\/command_ack$/.exec(topic);
    const deviceId = topicMatch ? deviceIdSchema.safeParse(topicMatch[1]).data : null;
    const parsed = commandAckPayloadSchema.safeParse(message);
    if (!deviceId || !parsed.success) {
      context.logger.warn({ topic }, 'Ignoring malformed MQTT command acknowledgement');
      return;
    }
    await handleCommandAck(context, deviceId, parsed.data);
  }
}
