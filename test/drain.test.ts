import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import type { SupabaseClient } from '@supabase/supabase-js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

Object.assign(process.env, {
  NODE_ENV: 'test', SUPABASE_URL: 'https://unit-test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
  MQTT_URL: 'mqtts://unit-test.invalid', MQTT_USERNAME: 'test', MQTT_PASSWORD: 'test', MQTT_ENABLED: 'false',
});
const { default: devicesRoutes } = await import('../src/modules/devices/routes.js');

const device = '11111111-1111-4111-8111-111111111111';
const user = '22222222-2222-4222-8222-222222222222';
const command = '33333333-3333-4333-8333-333333333333';

test('requires a confirmed drain and idempotency key before calling the owner-only RPC', async t => {
  const app = Fastify();
  t.after(() => app.close());
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async request => { request.user = { id: user }; });
  const calls: Record<string, unknown>[] = [];
  let result: Record<string, unknown> = { error: 'DEVICE_OWNER_REQUIRED' };
  app.decorate('supabase', {
    async rpc(name: string, args: Record<string, unknown>) {
      assert.equal(name, 'request_drain');
      calls.push(args);
      return { data: result, error: null };
    },
  } as unknown as SupabaseClient);
  await app.register(devicesRoutes);

  const send = (payload: object, key?: string) => app.inject({
    method: 'POST', url: `/v1/devices/${device}/command`, payload,
    headers: key ? { 'idempotency-key': key } : {},
  });
  const drain = { command: 'drain', duration_s: 5, confirmed: true };
  assert.equal((await send(drain)).statusCode, 400);
  assert.equal((await send({ command: 'drain', duration_s: 5 }, 'key')).statusCode, 400);
  assert.equal((await send({ ...drain, command: 'flush' }, 'key')).statusCode, 400);
  assert.equal((await send({ ...drain, duration_s: 16 }, 'key')).statusCode, 400);
  assert.equal(calls.length, 0);
  assert.equal((await send(drain, 'key')).statusCode, 403);

  result = { command_id: command, status: 'pending' };
  const accepted = await send(drain, 'key');
  assert.equal(accepted.statusCode, 202);
  assert.deepEqual(accepted.json(), result);
  assert.deepEqual(calls.at(-1), {
    p_device: device, p_owner: user, p_key: 'key', p_duration: 5, p_rate_ms: 10000, p_online_minutes: 5,
  });
  result = { error: 'IDEMPOTENCY_CONFLICT' };
  assert.equal((await send({ ...drain, duration_s: 6 }, 'key')).statusCode, 409);
});
