import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { requireAuthenticated, requireMember, requireOwner } from '../../lib/access.js';
import { AppError } from '../../lib/errors.js';

const sessionId = z.string().uuid();
const deviceId = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });

const sessionSchema = z.object({
  id: sessionId,
  device_id: deviceId,
  user_id: z.string().uuid().nullable(),
  volume_ml: z.number().int().positive(),
  avg_tds_out: z.number().int().nullable(),
  temperature_c: z.number().nullable(),
  start_ts: timestamp,
  end_ts: timestamp,
  created_at: timestamp.nullable(),
});

function databaseError(message: string, error: { message: string }) {
  return new AppError(500, 'DATABASE_ERROR', message, error.message);
}

const sessionsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/v1/sessions/guests',
    {
      schema: {
        tags: ['sessions'],
        summary: 'List unassigned guest sessions for a device',
        querystring: z.object({
          device_id: deviceId,
          limit: z.coerce.number().int().min(1).max(100).default(25),
          before: timestamp.optional(),
        }),
        response: { 200: z.object({ sessions: z.array(sessionSchema), next_before: timestamp.nullable() }) },
      },
    },
    async (request) => {
      const user = requireAuthenticated(request);
      const query = request.query as { device_id: string; limit: number; before?: string };
      await requireMember(app.supabase, user.id, query.device_id);

      let sessionsQuery = app.supabase
        .from('dispense_sessions')
        .select('id, device_id, user_id, volume_ml, avg_tds_out, temperature_c, start_ts, end_ts, created_at')
        .eq('device_id', query.device_id)
        .is('user_id', null)
        .order('start_ts', { ascending: false })
        .limit(query.limit);
      if (query.before) {
        sessionsQuery = sessionsQuery.lt('start_ts', query.before);
      }

      const { data, error } = await sessionsQuery;
      if (error) {
        throw databaseError('Unable to load guest sessions', error);
      }
      const sessions = (data ?? []) as z.infer<typeof sessionSchema>[];
      return {
        sessions,
        next_before: sessions.length === query.limit ? sessions[sessions.length - 1]?.start_ts ?? null : null,
      };
    },
  );

  app.put(
    '/v1/sessions/:id/assign',
    {
      schema: {
        tags: ['sessions'],
        summary: 'Assign a guest session to a device member',
        params: z.object({ id: sessionId }),
        body: z.object({ user_id: z.string().uuid() }),
        response: { 200: sessionSchema },
      },
    },
    async (request) => {
      const user = requireAuthenticated(request);
      const params = request.params as { id: string };
      const body = request.body as { user_id: string };
      const { data: session, error: sessionLookupError } = await app.supabase
        .from('dispense_sessions')
        .select('device_id')
        .eq('id', params.id)
        .maybeSingle();
      if (sessionLookupError) {
        throw databaseError('Unable to load dispense session', sessionLookupError);
      }
      if (!session) {
        throw new AppError(404, 'SESSION_NOT_FOUND', 'The dispense session does not exist');
      }

      const deviceIdForSession = (session as { device_id: string }).device_id;
      await requireOwner(app.supabase, user.id, deviceIdForSession);
      await requireMember(app.supabase, body.user_id, deviceIdForSession);

      const { data, error } = await app.supabase
        .from('dispense_sessions')
        .update({ user_id: body.user_id })
        .eq('id', params.id)
        .is('user_id', null)
        .select('id, device_id, user_id, volume_ml, avg_tds_out, temperature_c, start_ts, end_ts, created_at')
        .maybeSingle();
      if (error) {
        throw databaseError('Unable to assign dispense session', error);
      }
      if (!data) {
        throw new AppError(409, 'SESSION_ALREADY_ASSIGNED', 'The dispense session has already been assigned');
      }
      return data as z.infer<typeof sessionSchema>;
    },
  );
};

export default sessionsRoutes;
