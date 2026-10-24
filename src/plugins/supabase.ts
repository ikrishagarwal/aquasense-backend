import fp from 'fastify-plugin';
import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

export default fp(async (app) => {
  const client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  app.decorate('supabase', client);
});
