import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../lib/errors.js';

function isPublicRequest(request: FastifyRequest): boolean {
  const pathname = request.url.split('?', 1)[0];
  return request.method === 'OPTIONS'
    || pathname === '/health'
    || pathname.startsWith('/docs')
    || pathname.startsWith('/documentation');
}

export default fp(async (app) => {
  app.decorateRequest('user', null);

  app.addHook('onRequest', async (request) => {
    if (isPublicRequest(request)) {
      return;
    }

    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new AppError(401, 'UNAUTHORIZED', 'A Bearer token is required');
    }

    const token = authorization.slice('Bearer '.length).trim();
    if (!token) {
      throw new AppError(401, 'UNAUTHORIZED', 'A Bearer token is required');
    }

    const { data, error } = await app.supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new AppError(401, 'UNAUTHORIZED', 'The access token is invalid or expired');
    }

    request.user = {
      id: data.user.id,
      email: data.user.email,
      role: data.user.role,
    };
  });
});
