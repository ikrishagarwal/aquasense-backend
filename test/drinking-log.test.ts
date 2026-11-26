import assert from 'node:assert/strict';
import { test } from 'node:test';

const deviceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const enrollmentId = '44444444-4444-4444-8444-444444444444';
const first = {
  id: '33333333-3333-4333-8333-333333333333',
  start_ts: '2026-11-26T10:00:00.123456+00:00',
  end_ts: '2026-11-26T10:00:01+00:00',
  volume_ml: 2.25,
  tds_ppm: null,
  recognized_user_id: enrollmentId,
  recognized_user_name: 'Krish',
};
const second = {
  ...first, id: '33333333-3333-4333-8333-333333333332', tds_ppm: 82.35,
  recognized_user_id: null, recognized_user_name: null,
};
const latestTds = { tds_ppm: 84, end_ts: '2026-11-26T11:00:00+00:00' };

Object.assign(process.env, {
  NODE_ENV: 'test', LOG_LEVEL: 'silent', DOTENV_CONFIG_PATH: '/dev/null',
  SUPABASE_URL: 'https://unit-test.invalid', SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  MQTT_ENABLED: 'false',
});
const { buildApp } = await import('../src/app.js');

test('guest logs include display names without an account link', async (t) => {
  const unknownId = '55555555-5555-4555-8555-555555555555';
  const guest = {
    id: first.id, device_id: deviceId, user_id: null, recognized_user_id: enrollmentId,
    start_ts: first.start_ts, end_ts: first.end_ts, volume_ml: first.volume_ml,
    avg_tds_out: null, temperature_c: null, created_at: null, event_id: null, revision: null,
    pulse_count: null, tds_in: null, ph_approx: null, sensor_quality: null, confidence: null,
    recognition_status: null, volume_quality: null, incomplete: false, quality_flags: null,
  };
  let membership = true;
  let nameLookups = 0;
  t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const url = new URL(String(input));
    switch (url.pathname) {
      case '/auth/v1/user':
        return Response.json({ id: userId, role: 'authenticated' });
      case '/rest/v1/device_members':
        return Response.json(membership ? [{ device_id: deviceId, user_id: userId, role: 'member' }] : []);
      case '/rest/v1/dispense_sessions':
        assert.equal(url.searchParams.get('user_id'), 'is.null');
        assert.equal(url.searchParams.get('device_id'), `eq.${deviceId}`);
        return Response.json([
          guest,
          { ...guest, id: second.id, recognized_user_id: unknownId },
          { ...guest, id: '33333333-3333-4333-8333-333333333331', recognized_user_id: null },
        ]);
      case '/rest/v1/device_enrollment_names':
        nameLookups++;
        assert.equal(url.searchParams.get('device_id'), `eq.${deviceId}`);
        assert.equal(url.searchParams.get('recognized_user_id'), `in.(${enrollmentId},${unknownId})`);
        return Response.json([{ recognized_user_id: enrollmentId, display_name: 'Krish' }]);
      default:
        throw new Error(`Unexpected request to ${url.pathname}`);
    }
  });
  const app = await buildApp();
  t.after(() => app.close());
  function request() {
    return app.inject({
      url: `/v1/sessions/guests?device_id=${deviceId}`,
      headers: { authorization: 'Bearer user-token' },
    });
  }

  const response = await request();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().sessions.map((row: {
    user_id: string | null; recognized_user_name: string | null;
  }) => [row.user_id, row.recognized_user_name]), [[null, 'Krish'], [null, null], [null, null]]);
  assert.equal(nameLookups, 1);

  membership = false;
  assert.equal((await request()).statusCode, 403);
  assert.equal(nameLookups, 1);
});
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
