import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuthenticated } from '../../lib/access.js';
import { AppError } from '../../lib/errors.js';

const tokenBody = z.strictObject({ token: z.string().min(1).max(4096) });

const notificationsRoutes: FastifyPluginAsync = async app => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.put('/v1/notifications/token', { schema: { body: tokenBody } }, async (request, reply) => {
    const user = requireAuthenticated(request);
    const { error } = await app.supabase.from('notification_tokens')
      .upsert({ token: request.body.token, user_id: user.id });
    if (error) throw new AppError(500, 'TOKEN_WRITE_FAILED', 'Unable to register notification token');
    return reply.code(204).send();
  });
  typed.delete('/v1/notifications/token', { schema: { body: tokenBody } }, async (request, reply) => {
    const user = requireAuthenticated(request);
    const { error } = await app.supabase.from('notification_tokens').delete()
      .eq('token', request.body.token).eq('user_id', user.id);
    if (error) throw new AppError(500, 'TOKEN_DELETE_FAILED', 'Unable to remove notification token');
    return reply.code(204).send();
  });
};

export default notificationsRoutes;
