import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuthenticated } from '../../lib/access.js';
import { AppError } from '../../lib/errors.js';

const timestamp = z.string().datetime({ offset: true });
const position = z.tuple([timestamp, z.string().uuid()]);
const session = z.object({
  id: z.string().uuid(),
  start_ts: timestamp,
  end_ts: timestamp,
  volume_ml: z.number().nonnegative(),
  tds_ppm: z.number().nullable(),
  recognized_user_id: z.string().uuid().nullable(),
  recognized_user_name: z.string().nullable(),
});
const log = z.object({
  sessions: z.array(session),
  latest_tds: z.object({ tds_ppm: z.number(), end_ts: timestamp }).nullable(),
});

function decodeCursor(cursor: string): z.infer<typeof position> {
  try {
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.toString('base64url') === cursor) {
      return position.parse(JSON.parse(bytes.toString('utf8')));
    }
  } catch {
    // Invalid base64url payload, JSON, or cursor position.
  }
  throw new AppError(400, 'VALIDATION_ERROR', 'Invalid drinking log cursor');
}

const drinkingLogRoutes: FastifyPluginAsync = async (app) => {
  app.withTypeProvider<ZodTypeProvider>().get(
    '/v1/devices/:device_id/drinking-log',
    {
      schema: {
        tags: ['sessions'],
        summary: 'List your completed pours and the latest outlet TDS for a device',
        params: z.object({ device_id: z.string().uuid() }),
        querystring: z.object({
          cursor: z.string().min(1).max(256).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25),
        }),
        response: { 200: log.extend({ next_cursor: z.string().nullable() }) },
      },
    },
    async (request) => {
      const user = requireAuthenticated(request);
      const { cursor, limit } = request.query;
      const [beforeStart, beforeId] = cursor ? decodeCursor(cursor) : [null, null];
      const { data, error } = await app.supabase.rpc('read_drinking_log', {
        p_device_id: request.params.device_id,
        p_user_id: user.id,
        p_before_start: beforeStart,
        p_before_id: beforeId,
        p_limit: limit,
      });
      if (error) {
        throw new AppError(500, 'DATABASE_ERROR', 'Unable to load drinking log', error.message);
      }
      if (data === null) {
        throw new AppError(403, 'DEVICE_ACCESS_DENIED', 'You are not a member of this device');
      }

      const { sessions, latest_tds } = data as z.infer<typeof log>;
      const page = sessions.slice(0, limit);
      const last = page.at(-1);
      return {
        sessions: page,
        next_cursor: sessions.length > limit && last
          ? Buffer.from(JSON.stringify([last.start_ts, last.id])).toString('base64url')
          : null,
        latest_tds,
      };
    },
  );
};

export default drinkingLogRoutes;
