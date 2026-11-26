import assert from 'node:assert/strict';
import { test } from 'node:test';

const deviceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const first = {
  id: '33333333-3333-4333-8333-333333333333',
  start_ts: '2026-11-26T10:00:00.123456+00:00',
  end_ts: '2026-11-26T10:00:01+00:00',
  volume_ml: 2.25,
  tds_ppm: null,
};
const second = { ...first, id: '33333333-3333-4333-8333-333333333332', tds_ppm: 82.35 };
const latestTds = { tds_ppm: 84, end_ts: '2026-11-26T11:00:00+00:00' };

Object.assign(process.env, {
  NODE_ENV: 'test', LOG_LEVEL: 'silent', DOTENV_CONFIG_PATH: '/dev/null',
  SUPABASE_URL: 'https://unit-test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  MQTT_ENABLED: 'false',
});
const { buildApp } = await import('../src/app.js');

test('drinking log authenticates the caller and preserves the cursor position across pages', async (t) => {
  let rpcCalls = 0;
  let rpcResponse: { sessions: Array<typeof first | typeof second>; latest_tds: typeof latestTds | null } | null = null;
  let rpcArgs: unknown;
  t.mock.method(globalThis, 'fetch', async (...[input, init]: Parameters<typeof fetch>) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.pathname === '/auth/v1/user') {
      return authorization === 'Bearer user-token'
        ? Response.json({ id: userId, role: 'authenticated' })
        : Response.json({ message: 'Invalid JWT' }, { status: 401 });
    }
    assert.equal(url.pathname, '/rest/v1/rpc/read_drinking_log');
    assert.equal(authorization, 'Bearer service-key');
    rpcCalls++;
    rpcArgs = JSON.parse(String(init?.body));
    return Response.json(rpcResponse);
  });
  const app = await buildApp();
  t.after(() => app.close());
  const path = `/v1/devices/${deviceId}/drinking-log`;
  function request(query = '') {
    return app.inject({ url: path + query, headers: { authorization: 'Bearer user-token' } });
  }

  assert.equal((await app.inject({ url: path })).statusCode, 401);
  assert.equal((await app.inject({
    url: path, headers: { authorization: 'Bearer invalid-token' },
  })).statusCode, 401);
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?cursor=invalid', '?cursor=']) {
    assert.equal((await request(query)).statusCode, 400);
  }
  assert.equal(rpcCalls, 0);

  const denied = await request('?user_id=33333333-3333-4333-8333-333333333333');
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error.code, 'DEVICE_ACCESS_DENIED');
  const defaultArgs = {
    p_device_id: deviceId, p_user_id: userId, p_before_start: null, p_before_id: null, p_limit: 25,
  };
  assert.deepEqual(rpcArgs, defaultArgs);

  rpcResponse = { sessions: [], latest_tds: null };
  const empty = await request('?limit=100');
  assert.equal(empty.statusCode, 200);
  assert.deepEqual(empty.json(), { sessions: [], latest_tds: null, next_cursor: null });
  assert.deepEqual(rpcArgs, { ...defaultArgs, p_limit: 100 });

  rpcResponse = { sessions: [first, second], latest_tds: latestTds };
  const firstPage = await request('?limit=1');
  assert.equal(firstPage.statusCode, 200);
  const cursor = firstPage.json().next_cursor;
  assert.match(cursor, /^[\w-]+$/);
  assert.deepEqual(firstPage.json(), { sessions: [first], latest_tds: latestTds, next_cursor: cursor });

  rpcResponse = { sessions: [second], latest_tds: latestTds };
  const secondPage = await request(`?limit=1&cursor=${cursor}`);
  assert.equal(secondPage.statusCode, 200);
  assert.deepEqual(secondPage.json(), { sessions: [second], latest_tds: latestTds, next_cursor: null });
  assert.deepEqual(rpcArgs, {
    ...defaultArgs, p_before_start: first.start_ts, p_before_id: first.id, p_limit: 1,
  });
});
