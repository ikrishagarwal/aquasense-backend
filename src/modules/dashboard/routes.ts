import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuthenticated, requireMember } from '../../lib/access.js';
import { AppError } from '../../lib/errors.js';

const deviceId = z.string().uuid();

const dashboardSchema = z.object({
  device_id: deviceId,
  name: z.string(),
  status: z.enum(['offline', 'online', 'dispensing', 'flushing']),
  tank_level_ml: z.number().int().nullable(),
  current_tds: z.number().int().nullable(),
  filter_life_liters: z.number().nullable(),
  firmware_version: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  water_consumed_today_ml: z.number().int(),
  water_consumed_week_ml: z.number().int(),
  session_count_today: z.number().int(),
});

const dashboardRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/dashboard/:device_id',
    {
      schema: {
        tags: ['dashboard'],
        summary: 'Get the live device snapshot and usage summary',
        params: z.object({ device_id: deviceId }),
        response: { 200: dashboardSchema },
      },
    },
    async (request) => {
      const user = requireAuthenticated(request);
      const params = request.params as { device_id: string };
      await requireMember(app.supabase, user.id, params.device_id);

      const { data, error } = await app.supabase
        .from('dashboard_summary')
        .select('device_id, name, status, tank_level_ml, current_tds, filter_life_liters, firmware_version, last_seen_at, water_consumed_today_ml, water_consumed_week_ml, session_count_today')
        .eq('device_id', params.device_id)
        .maybeSingle();
      if (error) {
        throw new AppError(500, 'DASHBOARD_LOOKUP_FAILED', 'Unable to load the dashboard summary', error.message);
      }
      if (!data) {
        throw new AppError(404, 'DEVICE_NOT_FOUND', 'The requested device does not exist');
      }
      return data as z.infer<typeof dashboardSchema>;
    },
  );
};

export default dashboardRoutes;
