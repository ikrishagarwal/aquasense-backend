import type { SupabaseClient } from '@supabase/supabase-js';
import type { FastifyRequest } from 'fastify';
import { AppError } from './errors.js';

export type DeviceRole = 'owner' | 'member';

export interface Membership {
  device_id: string;
  user_id: string;
  role: DeviceRole;
}

export function requireAuthenticated(request: FastifyRequest) {
  if (!request.user) {
    throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
  }
  return request.user;
}

export async function getMembership(
  supabase: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<Membership | null> {
  const { data, error } = await supabase
    .from('device_members')
    .select('device_id, user_id, role')
    .eq('device_id', deviceId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new AppError(500, 'MEMBERSHIP_LOOKUP_FAILED', 'Unable to verify device membership', error.message);
  }
  return data as Membership | null;
}

export async function requireMember(
  supabase: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<Membership> {
  const membership = await getMembership(supabase, userId, deviceId);
  if (!membership) {
    throw new AppError(403, 'DEVICE_ACCESS_DENIED', 'You are not a member of this device');
  }
  return membership;
}

export async function requireOwner(
  supabase: SupabaseClient,
  userId: string,
  deviceId: string,
): Promise<Membership> {
  const membership = await requireMember(supabase, userId, deviceId);
  if (membership.role !== 'owner') {
    throw new AppError(403, 'DEVICE_OWNER_REQUIRED', 'Only a device owner can perform this action');
  }
  return membership;
}
