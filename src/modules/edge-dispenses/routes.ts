import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../../config.js';
import { AppError } from '../../lib/errors.js';

const uuid = z.uuid().transform(value => value.toLowerCase());
const timestamp = z.iso.datetime({ offset: true })
  .regex(/^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|\+00:00)$/)
  .transform(value => {
    const [seconds, fraction = ''] = value.replace(/(?:Z|\+00:00)$/, '').split('.');
    return `${seconds}.${fraction.padEnd(6, '0')}Z`;
  });
const dispense = z.strictObject({
  event_id: uuid,
  device_id: uuid,
  recognized_user_id: uuid.nullable(),
  start_ts: timestamp,
  end_ts: timestamp,
  volume_ml: z.number().positive(),
  tds_ppm: z.number().nonnegative().nullable(),
}).refine(value => value.start_ts <= value.end_ts, {
  path: ['end_ts'], message: 'The end timestamp must be at or after the start timestamp',
});

function tokenHash(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

const edgeDispenseRoutes: FastifyPluginAsync = async (app) => {
  const credentials = new Map(
    Array.from(config.AQUASENSE_DEVICE_TOKENS, ([device, token]) => [device, tokenHash(token)]),
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/v1/edge/dispenses',
    {
      schema: {
        tags: ['edge'],
        summary: 'Commit a completed Arduino dispense',
        body: dispense,
        response: { 200: z.object({ status: z.literal('committed') }) },
      },
    },
    async (request) => {
      const { body } = request;
      const token = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(request.headers.authorization ?? '')?.[1];
      const expected = credentials.get(body.device_id);
      if (!token || !expected || !timingSafeEqual(tokenHash(token), expected)) {
        throw new AppError(401, 'INVALID_DEVICE_TOKEN', 'The device bearer token is invalid');
      }

      const { data, error } = await app.supabase.rpc('commit_arduino_dispense', { p_dispense: body });
      if (!error) {
        if (data === 'committed') return { status: 'committed' as const };
        if (data === 'conflict') {
          throw new AppError(409, 'EVENT_CONFLICT', 'The event ID was already used with different data');
        }
        if (data === 'unknown_device') {
          throw new AppError(404, 'DEVICE_NOT_FOUND', 'The device has not been provisioned');
        }
      }
      request.log.error({ code: error?.code, event_id: body.event_id }, 'Arduino dispense commit failed');
      throw new AppError(500, 'DATABASE_ERROR', 'Unable to commit the dispense');
    },
  );
};

export default edgeDispenseRoutes;
