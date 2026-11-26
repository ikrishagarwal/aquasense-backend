import assert from 'node:assert/strict';
import { test } from 'node:test';

const event = {
  event_id: '11111111-1111-4111-8111-111111111111',
  device_id: '22222222-2222-4222-8222-222222222222',
  recognized_user_id: '33333333-3333-4333-8333-333333333333',
  start_ts: '2026-11-26T10:00:00.123456Z',
  end_ts: '2026-11-26T10:00:00.123457Z',
  volume_ml: 2.25,
  tds_ppm: 82.35,
};
const otherDevice = '44444444-4444-4444-8444-444444444444';

Object.assign(process.env, {
  NODE_ENV: 'test', LOG_LEVEL: 'silent', DOTENV_CONFIG_PATH: '/dev/null',
  SUPABASE_URL: 'https://unit-test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'test',
  MQTT_ENABLED: 'false',
  AQUASENSE_DEVICE_TOKENS: JSON.stringify({ [event.device_id]: 'device-token', [otherDevice]: 'other-token' }),
});
delete process.env.MQTT_URL;
delete process.env.MQTT_USERNAME;
delete process.env.MQTT_PASSWORD;
const { buildApp } = await import('../src/app.js');

test('device-authenticated HTTP dispenses validate and wait for the receipt RPC', async t => {
  const rows = new Map<string, string>();
  let rpcCalls = 0;
  let userAuthCalls = 0;
  t.mock.method(globalThis, 'fetch', async (...[input, init]: Parameters<typeof fetch>) => {
    const url = new URL(String(input));
    if (url.pathname === '/auth/v1/user') {
      userAuthCalls++;
      return Response.json({ message: 'Invalid JWT' }, { status: 401 });
    }
    assert.equal(url.pathname, '/rest/v1/rpc/commit_arduino_dispense');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test');
    rpcCalls++;
    const { p_dispense } = JSON.parse(String(init?.body));
    const payload = JSON.stringify(p_dispense);
    const key = `${p_dispense.device_id}/${p_dispense.event_id}`;
    const previous = rows.get(key);
    if (previous && previous !== payload) return Response.json('conflict');
    rows.set(key, payload);
    return Response.json('committed');
  });
  const app = await buildApp();
  t.after(() => app.close());
  function send(payload: object | string, token?: string) {
    return app.inject({
      method: 'POST', url: '/v1/edge/dispenses', payload,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
  }

  for (const token of [undefined, 'invalid-token', 'other-token']) {
    assert.equal((await send(event, token)).statusCode, 401);
  }
  const missingTds: Partial<typeof event> = { ...event };
  delete missingTds.tds_ppm;
  for (const invalid of [
    { ...event, extra: true },
    { ...event, event_id: 'invalid' },
    { ...event, recognized_user_id: 'Guest' },
    { ...event, volume_ml: 0 },
    { ...event, tds_ppm: -1 },
    { ...event, start_ts: event.end_ts, end_ts: event.start_ts },
    { ...event, end_ts: '2026-11-26T11:00:01+01:00' },
    missingTds,
    JSON.stringify(event).replace('"volume_ml":2.25', '"volume_ml":1e400'),
  ]) {
    assert.equal((await send(invalid, 'device-token')).statusCode, 400);
  }
  assert.equal(rpcCalls, 0);

  const accepted = await send(event, 'device-token');
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(accepted.json(), { status: 'committed' });
  assert.equal((await send({
    ...event, end_ts: event.end_ts.replace('Z', '+00:00'),
  }, 'device-token')).statusCode, 200);
  assert.equal((await send({ ...event, recognized_user_id: null }, 'device-token')).statusCode, 409);
  assert.deepEqual(JSON.parse(rows.get(`${event.device_id}/${event.event_id}`)!), event);
  assert.equal(rows.size, 1);
  assert.equal(userAuthCalls, 0);

  const userRoute = await app.inject({
    method: 'GET', url: `/v1/sessions/guests?device_id=${event.device_id}`,
    headers: { authorization: 'Bearer device-token' },
  });
  assert.equal(userRoute.statusCode, 401);
  assert.equal(userAuthCalls, 1);
});
