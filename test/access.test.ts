import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  getMembership,
  requireAuthenticated,
  requireMember,
  requireOwner,
} from '../src/lib/access.js';
import { AppError } from '../src/lib/errors.js';

const deviceId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';

function fakeSupabase(result: unknown, error: { message: string } | null = null) {
  const query = {
    select() { return query; },
    eq() { return query; },
    maybeSingle() { return Promise.resolve({ data: result, error }); },
  };
  return { from() { return query; } } as unknown as SupabaseClient;
}

test('returns a device membership when the user is connected', async () => {
  const membership = { device_id: deviceId, user_id: userId, role: 'member' as const };
  assert.deepEqual(await getMembership(fakeSupabase(membership), userId, deviceId), membership);
  assert.deepEqual(await requireMember(fakeSupabase(membership), userId, deviceId), membership);
});

test('rejects non-members and prevents members from owner-only actions', async () => {
  await assert.rejects(
    requireMember(fakeSupabase(null), userId, deviceId),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 403
      && error.code === 'DEVICE_ACCESS_DENIED',
  );

  const member = { device_id: deviceId, user_id: userId, role: 'member' as const };
  await assert.rejects(
    requireOwner(fakeSupabase(member), userId, deviceId),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 403
      && error.code === 'DEVICE_OWNER_REQUIRED',
  );
});

test('allows owners through owner checks and surfaces database lookup failures', async () => {
  const owner = { device_id: deviceId, user_id: userId, role: 'owner' as const };
  assert.deepEqual(await requireOwner(fakeSupabase(owner), userId, deviceId), owner);

  await assert.rejects(
    getMembership(fakeSupabase(null, { message: 'connection failed' }), userId, deviceId),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 500
      && error.code === 'MEMBERSHIP_LOOKUP_FAILED',
  );
});

test('requires an authenticated request before a route touches the database', () => {
  assert.throws(
    () => requireAuthenticated({ user: null } as never),
    (error: unknown) => error instanceof AppError
      && error.statusCode === 401
      && error.code === 'UNAUTHORIZED',
  );
  assert.equal(requireAuthenticated({ user: { id: userId } } as never).id, userId);
});
