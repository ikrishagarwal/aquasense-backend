import type { SupabaseClient } from '@supabase/supabase-js';
import type { MqttService } from '../plugins/mqtt.js';
import type { AuthenticatedUser } from './auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    supabase: SupabaseClient;
    mqtt: MqttService;
  }

  interface FastifyRequest {
    user: AuthenticatedUser | null;
  }
}
