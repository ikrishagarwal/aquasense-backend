import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        description: 'Liveness probe',
        response: {
          200: z.object({ ok: z.literal(true) }),
        },
      },
    },
    async () => ({ ok: true as const }),
  );
};

export default healthRoutes;
