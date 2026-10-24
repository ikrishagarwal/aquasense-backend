# AquaSense Backend Connection Guide

This guide takes a new developer from an empty checkout to a running AquaSense
backend connected to Supabase, an MQTT broker, a mobile/web client, and either
a real Raspberry Pi or the included mock publisher.

For the system overview and complete API contract, read [`README.md`](./README.md).
For the original product decisions, read [`IDEA.md`](./IDEA.md) and
[`PLAN.md`](./PLAN.md).

## What you will connect

```text
Client app
  ├── Supabase Auth: sign up/sign in and receive a user JWT
  ├── Fastify REST API: send the JWT in Authorization headers
  └── Supabase Realtime: subscribe to live devices updates

Fastify backend
  ├── Supabase service-role client: server-side reads/writes
  └── MQTT client: subscribe to telemetry and publish commands

Raspberry Pi / mock publisher
  ├── telemetry/status/<device_uuid>
  ├── telemetry/sessions/<device_uuid>
  ├── device/<device_uuid>/command_ack
  └── device/<device_uuid>/commands
```

## 1. Prerequisites

Install or obtain:

- Node.js 20 or newer. Node.js 22 or newer is recommended.
- pnpm 11 or newer.
- A Supabase project.
- An MQTT broker. HiveMQ Cloud is the planned broker; a TLS-enabled Mosquitto
  instance also works.
- A REST client such as curl, Postman, or VS Code REST Client.
- Optional: a Raspberry Pi with MQTT firmware, or use `scripts/mock-rpi.ts`.

Check the local versions:

```bash
node --version
pnpm --version
```

## 2. Install and configure the project

From the backend directory:

```bash
pnpm install
cp .env.example .env
```

Open `.env` and fill in at least:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key

MQTT_URL=mqtts://your-cluster.s1.eu.hivemq.cloud:8883
MQTT_USERNAME=your-backend-mqtt-user
MQTT_PASSWORD=your-backend-mqtt-password
MQTT_ENABLED=true
```

### Local HTTP-only mode

If Supabase is configured but MQTT is not ready yet, set:

```dotenv
MQTT_ENABLED=false
```

The backend will start without connecting to MQTT. REST routes that need
command publication will return `503 MQTT_UNAVAILABLE` until MQTT is enabled.
Telemetry ingestion will not happen while MQTT is disabled.

### Important secret rule

`SUPABASE_SERVICE_ROLE_KEY` and `MQTT_PASSWORD` are backend secrets. Never
commit `.env`, put the service-role key in the mobile app, or include either
secret in screenshots and HTTP examples.

## 3. Configure Supabase

### 3.1 Create or select a project

In the Supabase dashboard:

1. Create a project or open the AquaSense project.
2. Copy the project URL.
3. Copy the server-side service-role key from Project Settings → API.
4. Keep the service-role key only in the backend `.env`.

### 3.2 Apply the base schema

Open the Supabase SQL Editor and run the SQL in [`SQL.md`](./SQL.md). This
creates:

- `profiles`
- `devices`
- `dispense_sessions`
- `command_logs`
- The initial database constraints and policies

The base schema is the starting contract. It is not the final membership
policy by itself.

### 3.3 Apply the membership migration

Run the complete file below after the base schema:

```text
supabase/migrations/002_device_members.sql
```

This migration adds and configures:

- `profiles.email`
- `device_members`
- Owner/member roles
- Membership helper functions
- Membership-based RLS policies
- Existing profile and device-owner backfills
- Signup profile trigger
- Dashboard view
- Claim-device transaction
- Indexes
- Stale telemetry timestamp
- Command updated-at trigger

If using the Supabase CLI, run the migration through your normal linked-project
workflow. If using the dashboard, paste the file into the SQL Editor and run
it once after `SQL.md`.

### 3.4 Enable authentication

In Supabase Dashboard → Authentication → Providers:

1. Enable Email.
2. Configure email confirmation according to your demo needs.
3. Optionally enable Google OAuth later.

The backend verifies the access token using:

```text
supabase.auth.getUser(token)
```

The backend does not implement signup or password storage itself.

### 3.5 Enable Realtime

Enable Realtime for the `public.devices` table. This is what lets the app
receive live status changes after MQTT telemetry reaches Supabase.

Optionally enable Realtime for `public.dispense_sessions` if the app needs a
live session-history screen. The backend does not provide its own WebSocket
endpoint.

### 3.6 Register a device

Before a Raspberry Pi can publish useful telemetry, the UUID must exist in
`public.devices`. For an initial demo, insert one unclaimed device using the
Supabase SQL Editor:

```sql
insert into public.devices (name, status, owner_id)
values ('Demo Purifier', 'offline', null)
returning id;
```

Save the returned `id`. It is the device UUID used in every MQTT topic and in
the QR code or claim flow.

Do not create a second random device UUID in firmware. The topic UUID must be
the actual Supabase `devices.id` value.

## 4. Configure the MQTT broker

### 4.1 Create broker credentials

Create a backend MQTT user with permission to:

- Subscribe to `telemetry/status/+`.
- Subscribe to `telemetry/sessions/+`.
- Subscribe to `device/+/command_ack`.
- Publish to `device/+/commands`.

Create device credentials or ACLs so each Raspberry Pi can publish only to its
own telemetry topics and subscribe only to its own command topic. The current
backend validates UUIDs and registered devices, but MQTT credentials/ACLs are
still required to prevent one device from impersonating another.

### 4.2 Put broker values in `.env`

Example HiveMQ Cloud configuration:

```dotenv
MQTT_URL=mqtts://cluster-id.s1.eu.hivemq.cloud:8883
MQTT_USERNAME=aquasense-backend
MQTT_PASSWORD=replace-with-password
MQTT_ENABLED=true
```

The backend connects using TLS when the URL begins with `mqtts://`. The MQTT
plugin uses QoS 1 subscriptions and reconnects after a connection loss.

### 4.3 Backend subscriptions

At startup the backend subscribes to:

```text
telemetry/status/+
telemetry/sessions/+
device/+/command_ack
```

The `+` segment must contain the Supabase device UUID. The backend ignores
unknown devices and malformed payloads rather than crashing the process.

## 5. Start and verify the backend

Run the development server:

```bash
pnpm dev
```

You should see a listening message. Check the public health route:

```bash
curl -i http://localhost:3000/health
```

Expected:

```http
HTTP/1.1 200 OK
```

```json
{"ok":true}
```

Check Swagger:

```bash
curl -i http://localhost:3000/docs/json
```

Then open:

http://localhost:3000/docs

Check that protected routes reject requests without a token:

```bash
curl -i http://localhost:3000/v1/devices
```

Expected response:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "A Bearer token is required"
  }
}
```

## 6. Create users and obtain a JWT

You can create users in either of two ways.

### Option A: Supabase Dashboard

In Supabase Dashboard → Authentication → Users, create:

- An owner user, for example `owner@example.com`.
- A member user, for example `member@example.com`.

If email confirmation is enabled, confirm the accounts before signing in.

### Option B: Supabase client SDK

The frontend should use the anon/publishable key, not the service-role key:

```ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  'https://your-project.supabase.co',
  'your-anon-or-publishable-key',
);

await supabase.auth.signUp({
  email: 'owner@example.com',
  password: 'use-a-real-password',
});

const { data, error } = await supabase.auth.signInWithPassword({
  email: 'owner@example.com',
  password: 'use-a-real-password',
});

if (error) throw error;
const accessToken = data.session?.access_token;
```

Use the access token in Fastify requests:

```bash
curl http://localhost:3000/v1/devices \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

The signup trigger creates the corresponding `profiles` row. The owner can
only add a member by email after that member has signed up and has a profile.

## 7. Connect the client to the REST API

The API base URL is:

```text
http://localhost:3000
```

For a deployed backend, replace it with the HTTPS deployment URL. Keep the
`/v1` prefix for application routes.

### Generic request helper

```ts
const API_URL = 'http://localhost:3000';

async function apiRequest<T>(
  path: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${accessToken}`,
      ...init.headers,
    },
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Request failed with ${response.status}`);
  }
  return body as T;
}

const { devices } = await apiRequest<{ devices: unknown[] }>(
  '/v1/devices',
  accessToken,
);
```

### Recommended first client flow

1. Sign up or sign in with Supabase Auth.
2. Get the current session's `access_token`.
3. Call `GET /v1/devices`.
4. If the user has no devices, scan a QR code and call
   `POST /v1/devices/claim`.
5. Call `GET /v1/dashboard/:device_id` for the initial screen.
6. Subscribe to Supabase Realtime for device updates.
7. Call `GET /v1/sessions/guests` for guest-session management.
8. Call the command route only after displaying the current device status.

### Main REST calls

```ts
// Claim a QR-code device.
await apiRequest(`/v1/devices/claim`, accessToken, {
  method: 'POST',
  body: JSON.stringify({ device_id: deviceId }),
});

// Load dashboard data.
const dashboard = await apiRequest(
  `/v1/dashboard/${deviceId}`,
  accessToken,
);

// Add an already-registered user to the device.
await apiRequest(`/v1/devices/${deviceId}/members`, accessToken, {
  method: 'POST',
  body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
});

// Send a command.
await apiRequest(`/v1/devices/${deviceId}/command`, accessToken, {
  method: 'POST',
  body: JSON.stringify({ command: 'flush' }),
});
```

## 8. Connect the client to Supabase Realtime

The app uses the Supabase client for Realtime. It does not connect to a
Fastify WebSocket endpoint.

```ts
const channel = supabase
  .channel(`device-${deviceId}`)
  .on(
    'postgres_changes',
    {
      event: 'UPDATE',
      schema: 'public',
      table: 'devices',
      filter: `id=eq.${deviceId}`,
    },
    (payload) => {
      const liveDevice = payload.new;
      // Update the dashboard state here.
      console.log('Device changed:', liveDevice);
    },
  )
  .subscribe((status) => {
    console.log('Realtime status:', status);
  });

// Remove the channel when the screen/component unmounts.
await supabase.removeChannel(channel);
```

The authenticated client still needs to be allowed to read the device by the
membership RLS policy. A user who is not a member should not receive that
device's direct Realtime data.

## 9. Connect a real Raspberry Pi

The firmware needs:

- The broker URL and device-specific credentials.
- The registered Supabase device UUID.
- The exact topic names below.
- A locally generated UUID for every completed dispense session.
- A local retry queue for sessions when Wi-Fi or MQTT is unavailable.

### Publish status

```text
Topic: telemetry/status/<device_uuid>
```

```json
{
  "tds": 42,
  "tank_level_ml": 2500,
  "filter_life_liters": 100,
  "status": "online",
  "firmware_version": "1.4.2",
  "ts": "2026-10-20T12:00:00.000Z"
}
```

Publish status periodically. The backend uses `ts` to reject older packets,
and updates `last_seen_at` only after accepting a message.

### Publish a completed session

```text
Topic: telemetry/sessions/<device_uuid>
```

```json
{
  "id": "a-uuid-generated-on-the-rpi",
  "user_id": null,
  "start_ts": "2026-10-20T12:00:00.000Z",
  "end_ts": "2026-10-20T12:02:00.000Z",
  "volume_ml": 750,
  "avg_tds_out": 18,
  "temperature_c": 21.5
}
```

The Raspberry Pi must keep the same `id` when retrying the same event. Do not
generate a new UUID for every retry.

### Subscribe for commands

```text
Topic: device/<device_uuid>/commands
```

The backend publishes:

```json
{
  "command_id": "command-log-uuid",
  "command": "flush"
}
```

The firmware should execute the command and publish:

```text
Topic: device/<device_uuid>/command_ack
```

```json
{
  "command_id": "command-log-uuid",
  "status": "completed"
}
```

Use `failed` when the command cannot execute. Always echo the exact
`command_id`; it is how the backend joins the ACK to `command_logs`.

## 10. Use the mock Raspberry Pi

The mock publisher is useful before firmware is ready. It publishes status and
session messages but does not execute commands or publish ACKs.

Set the device UUID and run it from a second terminal:

```bash
DEVICE_ID=<registered-device-uuid> pnpm mock-rpi
```

Optional interval override:

```bash
DEVICE_ID=<registered-device-uuid> \
MOCK_RPI_INTERVAL_MS=2000 \
pnpm mock-rpi
```

The script reads the MQTT URL, username, and password from `.env`. It:

1. Publishes an initial online status.
2. Publishes status every interval.
3. Publishes a simulated 250 ml dispense session every interval.
4. Decreases the simulated tank and filter values.

Watch the backend logs for accepted telemetry. Then call the dashboard route
to see the persisted values:

```bash
curl "http://localhost:3000/v1/dashboard/<device_uuid>" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

## 11. Run the complete demo story

Use this order for a judge/demo presentation:

1. Start Supabase and confirm the migration is applied.
2. Start HiveMQ credentials and confirm the broker URL works.
3. Start the backend with `pnpm dev`.
4. Create or sign in as the owner.
5. Insert one unclaimed device and save its UUID.
6. Claim the device from the app or `POST /v1/devices/claim`.
7. Create/sign in as the second user, then add that user's email as a member.
8. Start the mock RPi or real firmware.
9. Show the dashboard updating through Supabase Realtime.
10. Show a guest session in `GET /v1/sessions/guests`.
11. Assign it to the member with `PUT /v1/sessions/:id/assign`.
12. Send `flush` as the owner.
13. Show the `pending`/`delivered` command log and publish an ACK.
14. Show the final `completed` command status.

The request sequence is also available in [`docs/demo.http`](./docs/demo.http).

## 12. Troubleshooting

### The server exits with invalid environment configuration

Check that all required values exist in `.env`:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MQTT_URL
MQTT_USERNAME
MQTT_PASSWORD
```

Run with the backend directory as the working directory. `dotenv/config` loads
`.env` from the process working directory.

### `GET /health` works but `/v1/devices` returns `401`

This is expected without a Supabase access token. The backend requires:

```http
Authorization: Bearer <access-token>
```

Do not use the Supabase anon key as the Bearer token. Sign in first and use the
returned `session.access_token`.

### The token is rejected

Check:

- The token came from the same Supabase project as `SUPABASE_URL`.
- The token is an access token, not a refresh token or anon key.
- The user has not signed out or expired the session.
- The server's Supabase URL and service-role key belong to the same project.

### The server says the MQTT broker is not connected

Check:

- `MQTT_ENABLED=true`.
- `MQTT_URL` includes the correct scheme and port.
- HiveMQ credentials are correct.
- The broker allows the backend client to connect and subscribe.
- The machine can reach the broker over TLS port `8883`.

The backend logs connection, reconnect, close, subscribe, and client errors.

### Telemetry is ignored

Check:

1. The topic UUID is a valid UUID.
2. That UUID exists in `public.devices`.
3. The JSON property names match the contract exactly.
4. `ts`, `start_ts`, and `end_ts` include a timezone offset, for example
   `2026-10-20T12:00:00.000Z`.
5. The status message is newer than `last_telemetry_at`.
6. The backend is subscribed to the exact topic prefix.

Malformed messages are logged and skipped. A malformed message does not stop
the MQTT client.

### Sessions are duplicated

The same session must be retried with the same `id`. If the firmware generates
a new UUID for every retry, the database correctly treats those as different
dispenses. Confirm the base `dispense_sessions.id` primary key exists.

### A command returns `DEVICE_OFFLINE`

The device must have:

- `status` other than `offline`.
- A recent accepted status message.
- A `last_seen_at` no older than `DEVICE_ONLINE_WINDOW_MINUTES`.

Start the mock publisher or publish a valid status message first.

### A flush or drain returns `DEVICE_BUSY`

The interlock intentionally rejects `flush` and `drain` while the device is
`dispensing` or `flushing`. Wait for a later `online` status update.

### Adding a member returns `PROFILE_NOT_FOUND`

The target email must already belong to a Supabase Auth user whose profile was
created by the signup trigger. Have the user sign up first, then retry the add
member request.

### The dashboard route cannot find `dashboard_summary`

Apply `supabase/migrations/002_device_members.sql` after `SQL.md` and grant
the authenticated role access to the view. The migration includes:

```sql
grant select on public.dashboard_summary to authenticated, service_role;
```

### The app does not receive Realtime updates

Check:

- `public.devices` is enabled in Supabase Realtime.
- The app is using the correct Supabase project URL/key.
- The Realtime filter uses the device UUID.
- The user has membership access to the device.
- The backend is actually accepting MQTT messages and updating the row.

### FCM alerts do not arrive

This is currently expected. The notification layer is a logging stub. The
backend logs that an alert was queued and how many device members were found,
but it does not send a Firebase push notification yet.

## 13. Run checks before handing off

Run these commands from the backend directory:

```bash
pnpm typecheck
pnpm test
pnpm build
```

For an HTTP smoke test without MQTT:

```bash
MQTT_ENABLED=false pnpm build
MQTT_ENABLED=false pnpm start
```

In another terminal:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/docs/json
curl -i http://localhost:3000/v1/devices
```

Stop the server with `Ctrl+C`.

## 14. Security and production checklist

Before production or a public demo:

- Use HTTPS for the Fastify API.
- Store secrets in the deployment secret manager.
- Rotate any key that has been exposed.
- Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.
- Configure restrictive CORS instead of the current hackathon `origin: true`.
- Configure MQTT ACLs or per-device credentials.
- Apply and verify the membership migration.
- Confirm RLS with an owner, member, and non-member account.
- Configure database backups and retention.
- Add durable ingestion storage if MQTT/database outages must survive process
  restarts.
- Implement Firebase Admin/FCM delivery before promising push notifications.
- Run a real broker and Supabase integration test.

## Reference files

- [`README.md`](./README.md) — complete architecture and API reference.
- [`IDEA.md`](./IDEA.md) — original architecture brainstorm.
- [`PLAN.md`](./PLAN.md) — implementation phases and decisions.
- [`SQL.md`](./SQL.md) — base schema.
- [`supabase/migrations/002_device_members.sql`](./supabase/migrations/002_device_members.sql) — membership migration.
- [`docs/demo.http`](./docs/demo.http) — REST demo requests.
- [`scripts/mock-rpi.ts`](./scripts/mock-rpi.ts) — mock MQTT publisher.
