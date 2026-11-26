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
  ├── publishes purifier/<device_uuid>/{events,telemetry,ack,status}
  └── subscribes to purifier/<device_uuid>/{events_ack,cmd}
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

The backend starts without MQTT settings. Telemetry ingestion and drain dispatch
require a broker connection. An undispatched drain request expires after 15 seconds.

### Arduino HTTPS delivery on Render

1. Apply [the Arduino dispense migration](supabase/migrations/004_arduino_dispenses.sql)
   after migrations 002 and 003, using the project's usual migration workflow.
   Generate a stable device UUID once for a new Pi, or use the Pi's existing
   provisioned UUID. For a new device, insert it with a name in Supabase.

   ```sql
   INSERT INTO public.devices (id, name)
   VALUES ('<stable-device-uuid>', 'Arduino purifier')
   ON CONFLICT (id) DO NOTHING;
   ```

2. Generate one random token per device with `openssl rand -hex 32`. Store
   `AQUASENSE_DEVICE_TOKENS` in Render as a JSON object of the form
   `{"<stable-device-uuid>":"<per-device-token>"}`. Set
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in Render. Set
   `MQTT_ENABLED=false` for HTTP-only operation.
3. Deploy the backend source as a Render Node web service. Use
   `pnpm install --frozen-lockfile && pnpm build` to build, `pnpm start` to
   start, and `/health` for the health check. Set `NODE_VERSION=26.2.0` and
   use pnpm 11.5.2 to match local verification. Render supplies `PORT` and the
   app defaults to `HOST=0.0.0.0`.
   [Render Fastify setup](https://render.com/docs/deploy-node-fastify-app)
   [Render Node.js version settings](https://render.com/docs/node-version)
4. Set `AQUASENSE_BACKEND_URL` to the Render HTTPS origin on the Pi, with
   `AQUASENSE_DEVICE_ID` and `AQUASENSE_DEVICE_TOKEN` matching the Render
   secret. Start the monitor with its active vision config and make a recognized
   pour. Compare the console summary with the latest session for that device.

   ```sql
   SELECT event_id, recognized_user_id, user_id, start_ts, end_ts,
          volume_ml, avg_tds_out
   FROM public.dispense_sessions
   WHERE device_id = '<stable-device-uuid>'
   ORDER BY start_ts DESC
   LIMIT 1;
   ```

`POST /v1/edge/dispenses` returns `200` with `{"status":"committed"}` after the
transaction commits, including for an identical retry. Reusing the event ID
with changed data returns `409`. The route accepts UTC timestamps with
up to six fractional digits. The authorized session endpoints include both
the Pi's `recognized_user_id` and the Supabase account assignment `user_id`.

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

Apply `supabase/migrations/003_edge_v1.sql` after the membership migration.
Apply `supabase/migrations/004_arduino_dispenses.sql` after migration 003.

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

Use separate credentials for the backend and each device, with the topic ACLs
in the [MQTT contract](README.md#mqtt-contract). Clear retained commands
before cutover.

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

The backend subscribes to `purifier/+/events`, `purifier/+/ack`, and
`purifier/+/status` at QoS 1, and `purifier/+/telemetry` at QoS 0.

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
  headers: { 'Idempotency-Key': crypto.randomUUID() },
  body: JSON.stringify({ command: 'drain', duration_s: 5, confirmed: true }),
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

## 9. Connect a Raspberry Pi in simulation

Use a registered device UUID and verified MQTT TLS. Follow the
[version 1 MQTT contract](README.md#mqtt-contract) and the adjacent edge
project's simulation setup. Confirm durable event replay and a rejected drain
with reason `actuation_disabled`.

## 10. Use the mock Raspberry Pi

Set `DEVICE_ID` to a registered UUID and use that device's credentials when
running `pnpm mock-rpi`. See the [demo requests](docs/demo.http) for a drain
request and the [demo flow](README.md#running-the-demo-flow) for verification.

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
4. `timestamp`, `start_ts`, and `end_ts` include a UTC timezone offset, for example
   `2026-10-20T12:00:00.000Z`.
5. The telemetry timestamp is newer than `last_telemetry_at`.
6. The backend is subscribed to the exact topic prefix.

Malformed messages are logged and skipped. A malformed message does not stop
the MQTT client.

### Sessions are duplicated

The same session must be retried with the same `event_id`. If the firmware generates
a new UUID for every retry, the database correctly treats those as different
dispenses. Confirm migration `003_edge_v1.sql` is applied.

### A command returns `DEVICE_OFFLINE`

The device must have:

- `status` other than `offline`.
- A recent accepted status message.
- A `last_seen_at` no older than `DEVICE_ONLINE_WINDOW_MINUTES`.

Start the mock publisher or publish a valid status message first.

### A drain returns `DEVICE_BUSY`

The backend rejects requests while a device reports a busy state. The Pi
independently evaluates its local interlocks.

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

Verify the service account path and permissions, register the app token, and
check the worker logs and `alert_outbox` / `alert_deliveries` tables.

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
- Configure FCM credentials and verify mobile token registration and delivery.
- Run a real broker and Supabase integration test.

## Reference files

- [`README.md`](./README.md) — complete architecture and API reference.
- [`IDEA.md`](./IDEA.md) — original architecture brainstorm.
- [`PLAN.md`](./PLAN.md) — implementation phases and decisions.
- [`SQL.md`](./SQL.md) — base schema.
- [`supabase/migrations/002_device_members.sql`](./supabase/migrations/002_device_members.sql) — membership migration.
- [`docs/demo.http`](./docs/demo.http) — REST demo requests.
- [`scripts/mock-rpi.ts`](./scripts/mock-rpi.ts) — mock MQTT publisher.
