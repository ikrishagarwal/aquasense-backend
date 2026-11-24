import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { lifecycleStatus, tankState, telemetryPayloadSchema } from '../../ingestion/schemas.js';
import { config } from '../../config.js';
import { requireAuthenticated, requireMember, requireOwner } from '../../lib/access.js';
import { AppError } from '../../lib/errors.js';

const deviceId = z.string().uuid();
const role = z.enum(['owner', 'member']);
const commandStatus = z.union([z.enum(['pending', 'delivered']), lifecycleStatus]);
const commandResult = z.object({ command_id: z.string().uuid(), status: commandStatus });
const commandHistory = z.object({
  revision: z.number().int(),
  status: lifecycleStatus,
  reason: z.string(),
  timestamp: z.string(),
  valve_state: z.enum(['commanded_open', 'commanded_closed']),
});
const drainErrors: Record<string, [number, string]> = {
  DEVICE_NOT_FOUND: [404, 'The purifier does not exist'],
  DEVICE_OWNER_REQUIRED: [403, 'Only the owner can request a drain'],
  DEVICE_OFFLINE: [409, 'The purifier is offline'],
  DEVICE_BUSY: [409, 'The purifier is busy'],
  IDEMPOTENCY_CONFLICT: [409, 'The idempotency key was already used for a different request'],
  COMMAND_RATE_LIMITED: [429, 'Wait before requesting another drain'],
  INVALID_DRAIN: [400, 'Invalid drain request'],
};

const deviceSchema = z.object({
  id: deviceId,
  owner_id: z.string().uuid().nullable(),
  name: z.string(),
  status: z.enum(['offline', 'online', 'dispensing', 'flushing']),
  tank_state: tankState,
  telemetry: telemetryPayloadSchema.nullable(),
  firmware_version: z.string().nullable(),
  last_seen_at: z.string().nullable(),
  created_at: z.string().nullable(),
});

const memberSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email().nullable(),
  display_name: z.string().nullable(),
  avatar_url: z.string().nullable(),
  role,
  created_at: z.string().nullable(),
});

type DeviceRow = z.infer<typeof deviceSchema>;

function databaseError(message: string, error: { message: string }) {
  return new AppError(500, 'DATABASE_ERROR', message, error.message);
}

function mapDevice(device: DeviceRow, memberRole: 'owner' | 'member') {
  return { ...device, role: memberRole };
}

const devicesRoutes: FastifyPluginAsync = async (app) => {

  app.get(
    '/v1/devices',
    {
      schema: {
        tags: ['devices'],
        summary: 'List devices available to the current user',
        response: { 200: z.object({ devices: z.array(deviceSchema.extend({ role })) }) },
      },
    },
    async (request) => {
      const user = requireAuthenticated(request);
      const { data: memberships, error: membershipError } = await app.supabase
        .from('device_members')
        .select('device_id, role')
        .eq('user_id', user.id);
      if (membershipError) {
        throw databaseError('Unable to load device memberships', membershipError);
      }

      const rows = (memberships ?? []) as Array<{ device_id: string; role: 'owner' | 'member' }>;
      if (rows.length === 0) {
        return { devices: [] };
      }

      const { data: devices, error: deviceError } = await app.supabase
        .from('devices')
        .select('id, owner_id, name, status, tank_state, telemetry, firmware_version, last_seen_at, created_at')
        .in('id', rows.map((membership) => membership.device_id));
      if (deviceError) {
        throw databaseError('Unable to load devices', deviceError);
      }

      const byId = new Map((devices as DeviceRow[] | null ?? []).map((device) => [device.id, device]));
      return {
        devices: rows
          .map((membership) => {
            const device = byId.get(membership.device_id);
            return device ? mapDevice(device, membership.role) : null;
          })
          .filter((device): device is DeviceRow & { role: 'owner' | 'member' } => device !== null),
      };
    },
  );

  app.post(
    '/v1/devices/claim',
    {
      schema: {
        tags: ['devices'],
        summary: 'Claim an unclaimed purifier',
        body: z.object({ device_id: deviceId }),
        response: { 201: deviceSchema.extend({ role: z.literal('owner') }) },
      },
    },
    async (request, reply) => {
      const user = requireAuthenticated(request);
      const body = request.body as { device_id: string };
      const { data, error } = await app.supabase.rpc('claim_device', {
        requested_device_id: body.device_id,
        requesting_user_id: user.id,
      });
      if (error) {
        if (error.code === 'P0001' || error.message.toLowerCase().includes('already claimed')) {
          throw new AppError(409, 'DEVICE_ALREADY_CLAIMED', 'This device has already been claimed');
        }
        if (error.code === 'P0002' || error.message.toLowerCase().includes('not found')) {
          throw new AppError(404, 'DEVICE_NOT_FOUND', 'The requested device does not exist');
        }
        throw databaseError('Unable to claim device', error);
      }
      if (!data) {
        throw new AppError(500, 'DEVICE_CLAIM_FAILED', 'The device was not claimed');
      }
      return reply.status(201).send({ ...(data as DeviceRow), role: 'owner' as const });
    },
  );

  app.get(
    '/v1/devices/:device_id/members',
    {
      schema: {
        tags: ['members'],
        summary: 'List members of a device',
        params: z.object({ device_id: deviceId }),
        response: { 200: z.object({ members: z.array(memberSchema) }) },
      },
    },
    async (request) => {
      const user = requireAuthenticated(request);
      const params = request.params as { device_id: string };
      await requireMember(app.supabase, user.id, params.device_id);

      const { data, error } = await app.supabase
        .from('device_members')
        .select('user_id, role, created_at, profiles(id, email, display_name, avatar_url)')
        .eq('device_id', params.device_id)
        .order('created_at', { ascending: true });
      if (error) {
        throw databaseError('Unable to load device members', error);
      }

      type JoinedMember = {
        user_id: string;
        role: 'owner' | 'member';
        created_at: string | null;
        profiles: Array<{ id: string; email: string | null; display_name: string | null; avatar_url: string | null }>
          | { id: string; email: string | null; display_name: string | null; avatar_url: string | null }
          | null;
      };
      return {
        members: ((data ?? []) as unknown as JoinedMember[]).map((member) => ({
          ...(() => {
            const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
            return {
              email: profile?.email ?? null,
              display_name: profile?.display_name ?? null,
              avatar_url: profile?.avatar_url ?? null,
            };
          })(),
          user_id: member.user_id,
          role: member.role,
          created_at: member.created_at,
        })),
      };
    },
  );

  app.post(
    '/v1/devices/:device_id/members',
    {
      schema: {
        tags: ['members'],
        summary: 'Add a member to a device by email',
        params: z.object({ device_id: deviceId }),
        body: z.object({ email: z.string().email(), role }),
        response: { 201: memberSchema },
      },
    },
    async (request, reply) => {
      const user = requireAuthenticated(request);
      const params = request.params as { device_id: string };
      await requireOwner(app.supabase, user.id, params.device_id);
      const body = request.body as { email: string; role: 'owner' | 'member' };

      const { data: profile, error: profileError } = await app.supabase
        .from('profiles')
        .select('id, email, display_name, avatar_url')
        .ilike('email', body.email.trim())
        .maybeSingle();
      if (profileError) {
        throw databaseError('Unable to look up member profile', profileError);
      }
      if (!profile) {
        throw new AppError(404, 'PROFILE_NOT_FOUND', 'The user must sign up before they can be added');
      }
      if (profile.id === user.id && body.role !== 'owner') {
        throw new AppError(400, 'CANNOT_DEMOTE_SELF', 'An owner cannot demote themselves from a device');
      }

      const { error: upsertError } = await app.supabase
        .from('device_members')
        .upsert({ device_id: params.device_id, user_id: profile.id, role: body.role }, { onConflict: 'device_id,user_id' });
      if (upsertError) {
        throw databaseError('Unable to add device member', upsertError);
      }

      return reply.status(201).send({
        user_id: profile.id,
        email: profile.email,
        display_name: profile.display_name,
        avatar_url: profile.avatar_url,
        role: body.role,
        created_at: null,
      });
    },
  );

  app.patch(
    '/v1/devices/:device_id/members/:user_id',
    {
      schema: {
        tags: ['members'],
        summary: 'Change a device member role',
        params: z.object({ device_id: deviceId, user_id: z.string().uuid() }),
        body: z.object({ role }),
        response: { 200: memberSchema },
      },
    },
    async (request) => {
      const user = requireAuthenticated(request);
      const params = request.params as { device_id: string; user_id: string };
      await requireOwner(app.supabase, user.id, params.device_id);
      const body = request.body as { role: 'owner' | 'member' };
      if (params.user_id === user.id && body.role !== 'owner') {
        throw new AppError(400, 'CANNOT_DEMOTE_SELF', 'An owner cannot demote themselves from a device');
      }
      const { data, error } = await app.supabase
        .from('device_members')
        .update({ role: body.role })
        .eq('device_id', params.device_id)
        .eq('user_id', params.user_id)
        .select('user_id, role, created_at, profiles(id, email, display_name, avatar_url)')
        .maybeSingle();
      if (error) {
        throw databaseError('Unable to update device member', error);
      }
      if (!data) {
        throw new AppError(404, 'MEMBER_NOT_FOUND', 'The device member does not exist');
      }
      const member = data as unknown as {
        user_id: string;
        role: 'owner' | 'member';
        created_at: string | null;
        profiles: Array<{ email: string | null; display_name: string | null; avatar_url: string | null }>
          | { email: string | null; display_name: string | null; avatar_url: string | null }
          | null;
      };
      const profile = Array.isArray(member.profiles) ? member.profiles[0] : member.profiles;
      return {
        user_id: member.user_id,
        email: profile?.email ?? null,
        display_name: profile?.display_name ?? null,
        avatar_url: profile?.avatar_url ?? null,
        role: member.role,
        created_at: member.created_at,
      };
    },
  );

  app.delete(
    '/v1/devices/:device_id/members/:user_id',
    {
      schema: {
        tags: ['members'],
        summary: 'Remove a member from a device',
        params: z.object({ device_id: deviceId, user_id: z.string().uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const user = requireAuthenticated(request);
      const params = request.params as { device_id: string; user_id: string };
      await requireOwner(app.supabase, user.id, params.device_id);
      if (params.user_id === user.id) {
        throw new AppError(400, 'CANNOT_REMOVE_SELF', 'An owner cannot remove themselves from a device');
      }

      const { error } = await app.supabase
        .from('device_members')
        .delete()
        .eq('device_id', params.device_id)
        .eq('user_id', params.user_id);
      if (error) {
        throw databaseError('Unable to remove device member', error);
      }
      return reply.status(204).send();
    },
  );

  const commands = app.withTypeProvider<import('fastify-type-provider-zod').ZodTypeProvider>();
  commands.post('/v1/devices/:device_id/command', {
    schema: {
      tags: ['devices'],
      summary: 'Queue a confirmed drain request',
      params: z.object({ device_id: deviceId }),
      headers: z.object({ 'idempotency-key': z.string().min(1).max(128).regex(/^[!-~]+$/) }).passthrough(),
      body: z.strictObject({
        command: z.literal('drain'), duration_s: z.number().positive().max(config.DRAIN_MAX_DURATION_S),
        confirmed: z.literal(true),
      }),
      response: { 202: commandResult },
    },
  }, async (request, reply) => {
    const user = requireAuthenticated(request);
    const { data, error } = await app.supabase.rpc('request_drain', {
      p_device: request.params.device_id,
      p_owner: user.id,
      p_key: request.headers['idempotency-key'],
      p_duration: request.body.duration_s,
      p_rate_ms: config.COMMAND_RATE_LIMIT_MS,
      p_online_minutes: config.DEVICE_ONLINE_WINDOW_MINUTES,
    });
    if (error) throw databaseError('Unable to record drain request', error);
    if (data?.error) {
      const [status, message] = drainErrors[data.error] ?? [500, 'Unable to record drain request'];
      throw new AppError(status, data.error, message);
    }
    return reply.code(202).send(commandResult.parse(data));
  });

  commands.get('/v1/devices/:device_id/commands/:command_id', {
    schema: {
      tags: ['devices'],
      params: z.object({ device_id: deviceId, command_id: deviceId }),
      response: { 200: commandResult.extend({
        command: z.string(), issued_at: z.string().nullable(), expires_at: z.string().nullable(),
        broker_delivered_at: z.string().nullable(), history: z.array(commandHistory),
      }) },
    },
  }, async request => {
    const user = requireAuthenticated(request);
    const { device_id, command_id } = request.params;
    await requireMember(app.supabase, user.id, device_id);
    const { data, error } = await app.supabase.from('command_logs')
      .select('command, status, issued_at, expires_at, broker_delivered_at, history:command_history(revision,status,reason,timestamp,valve_state)')
      .eq('device_id', device_id).eq('id', command_id).maybeSingle();
    if (error) throw databaseError('Unable to load command history', error);
    if (!data) throw new AppError(404, 'COMMAND_NOT_FOUND', 'The command does not exist');
    const history = commandHistory.array().parse(data.history).sort((a, b) => a.revision - b.revision);
    return { command_id, ...data, status: commandStatus.parse(data.status), history };
  });
};

export default devicesRoutes;
