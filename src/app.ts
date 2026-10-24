import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z, ZodError } from 'zod';
import { config } from './config.js';
import supabasePlugin from './plugins/supabase.js';
import authPlugin from './plugins/auth.js';
import mqttPlugin from './plugins/mqtt.js';
import healthRoutes from './modules/health/routes.js';
import devicesRoutes from './modules/devices/routes.js';
import sessionsRoutes from './modules/sessions/routes.js';
import dashboardRoutes from './modules/dashboard/routes.js';
import { AppError } from './lib/errors.js';

export async function buildApp() {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(helmet);
  await app.register(cors, { origin: true });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'AquaSense API',
        description: 'Backend API for the AquaSense smart water purifier',
        version: '0.1.0',
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: z.flattenError(error),
        },
      });
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      });
    }
    const err = error as { statusCode?: number; code?: string; message?: string };
    const validationError = error as {
      code?: string;
      validation?: unknown;
    };
    if (validationError.code === 'FST_ERR_VALIDATION' || validationError.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: validationError.validation ?? err.message,
        },
      });
    }
    const statusCode = typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (statusCode >= 500) {
      request.log.error(error);
    }
    return reply.status(statusCode).send({
      error: {
        code: err.code ?? 'INTERNAL_ERROR',
        message: statusCode >= 500 ? 'Internal server error' : (err.message ?? 'Request failed'),
      },
    });
  });

  await app.register(supabasePlugin);
  await app.register(authPlugin);
  await app.register(mqttPlugin);
  await app.register(healthRoutes);
  await app.register(devicesRoutes);
  await app.register(sessionsRoutes);
  await app.register(dashboardRoutes);

  return app;
}
