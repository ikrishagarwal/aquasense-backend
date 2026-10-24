import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyBaseLogger } from 'fastify';

export interface DeviceAlert {
  type: 'filter_life_low' | 'tank_level_low';
  message: string;
}

/**
 * FCM intentionally stays behind this interface during the hackathon. It logs
 * alerts until a Firebase service account is configured, without making MQTT
 * ingestion depend on Firebase being installed or reachable.
 */
export async function notifyMembers(
  supabase: SupabaseClient,
  deviceId: string,
  alert: DeviceAlert,
  logger: FastifyBaseLogger,
): Promise<void> {
  const { data, error } = await supabase
    .from('device_members')
    .select('user_id')
    .eq('device_id', deviceId);

  if (error) {
    logger.warn({ deviceId, alert, error: error.message }, 'Unable to load members for device alert');
    return;
  }

  logger.info(
    { deviceId, recipientCount: data?.length ?? 0, alert },
    'Device alert notification queued (FCM stub)',
  );
}
