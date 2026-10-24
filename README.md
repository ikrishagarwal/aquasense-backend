# AquaSense Backend

Backend for the AquaSense smart water purifier. It connects the mobile app,
Supabase, the Raspberry Pi firmware, and an MQTT broker through one Fastify
application.

The backend has two jobs:

1. Serve an authenticated REST API for the mobile app.
2. Subscribe to purifier telemetry over MQTT, persist it in Supabase, and
   publish commands back to the purifier.

The app does not need a second WebSocket service for live device data. The
backend updates Supabase, and the mobile app can subscribe to Supabase
Realtime for changes to the `devices` table.

> **Start here:** [`GUIDE.md`](./GUIDE.md) is the step-by-step setup and
> connection guide. This README describes the complete implementation and
> system contract.

## Status

Implemented in this workspace:

- Fastify 5 + TypeScript ESM backend
- Zod validation and OpenAPI/Swagger documentation
- Supabase service-role integration
- Supabase Auth JWT verification
- Membership-based device authorization
- Device claiming and household member management
- Dashboard usage aggregation
- Guest dispense-session assignment
- MQTT telemetry ingestion
- Idempotent session ingestion for Raspberry Pi retries
- MQTT command dispatch and command acknowledgements
- Online-device and busy-device command interlocks
- Per-device command rate limiting
- MQTT ingestion retry handling
- Low filter/tank alert notification interface
- Mock Raspberry Pi publisher
- Unit tests for access control and ingestion boundaries

Not yet connected to external services in this workspace:

- The migration still needs to be applied to the real Supabase project.
- A real HiveMQ/Mosquitto end-to-end test still needs to be run.
- FCM is currently a safe logging stub; no push notification is sent yet.

## Architecture

```text
                    Supabase Auth
                         │ JWT
                         ▼
Mobile app ────────► Fastify REST API ───────► Supabase Postgres
     │                    │                         │
     │                    │                         └─ Realtime: devices
     │                    │
     │                    └──── MQTT publish ─────► HiveMQ Cloud
     │                                                   │
     └──── Supabase Realtime subscription ◄──────────────┘

Raspberry Pi ───── MQTT status/session messages ─────► Fastify
Raspberry Pi ◄──── MQTT device commands ───────────── Fastify
Raspberry Pi ───── command acknowledgements ─────────► Fastify
```

### Runtime responsibilities

- **Fastify:** HTTP routes, authentication, authorization, validation,
  command dispatch, MQTT lifecycle.
- **Supabase Auth:** user signup/login and access-token issuance.
- **Supabase Postgres:** profiles, devices, memberships, sessions, command
  logs, RLS, and dashboard aggregation.
- **Supabase Realtime:** live changes for the mobile dashboard.
- **MQTT broker:** transport between the backend and Raspberry Pi devices.
- **Raspberry Pi:** generates session UUIDs, publishes telemetry, stores and
  retries local events when the network is unavailable.

### Security model

There are two different Supabase clients in the overall system:

- The **mobile app** uses the Supabase URL and anon/publishable key to use
  Supabase Auth and Realtime.
- This **backend** uses `SUPABASE_SERVICE_ROLE_KEY`. That key bypasses RLS and
  must remain server-side. Because the backend client bypasses RLS, every
  device-scoped REST route explicitly calls `requireMember()` or
  `requireOwner()`.

Device roles are stored in `device_members`, not on the profile:

- `owner`: manages members, device settings, and owner-only commands such as
  `flush` and `drain`.
- `member`: views shared devices and sessions and can issue the household
  commands allowed by the current API.

The SQL migration also installs membership-based RLS as a defense-in-depth
backstop for direct Supabase client access.

## Technology

- Node.js 20+; Node.js 22+ is recommended for the current Supabase package
- pnpm 11+
- Fastify 5
- TypeScript 5.9
- Zod 4
- `fastify-type-provider-zod`
- `@supabase/supabase-js`
- MQTT.js 5
- HiveMQ Cloud or another MQTT broker supporting MQTT over TLS

## Project layout

```text
.
├── src/
│   ├── index.ts                    # Process entry point and graceful shutdown
│   ├── app.ts                      # Fastify application factory
│   ├── config.ts                   # Zod environment validation
│   ├── types/
│   │   ├── auth.ts                 # Authenticated user shape
│   │   └── fastify.d.ts            # Fastify type augmentation
│   ├── plugins/
│   │   ├── supabase.ts             # Service-role Supabase client
│   │   ├── auth.ts                 # Bearer JWT verification
│   │   └── mqtt.ts                 # MQTT connect/subscribe/publish/close
│   ├── lib/
│   │   ├── access.ts               # Member/owner authorization helpers
│   │   ├── errors.ts               # Application error type
│   │   └── fcm.ts                  # Alert notification interface/stub
│   ├── ingestion/
│   │   ├── schemas.ts              # Raspberry Pi MQTT contract
│   │   └── handlers.ts             # Telemetry and ACK persistence
│   └── modules/
│       ├── health/routes.ts
│       ├── devices/routes.ts       # Devices, members, commands
│       ├── sessions/routes.ts       # Guest sessions and assignment
│       └── dashboard/routes.ts      # Usage/device summary
├── supabase/
│   └── migrations/
│       └── 002_device_members.sql  # Membership/RLS/dashboard migration
├── scripts/
│   └── mock-rpi.ts                 # MQTT telemetry demo publisher
├── docs/
│   └── demo.http                   # REST Client demo sequence
├── test/
│   ├── access.test.ts
│   └── ingestion.test.ts
├── IDEA.md                         # Original architecture/product notes
├── PLAN.md                         # Detailed implementation plan
├── SQL.md                          # Base database schema
├── GUIDE.md                        # Setup and connection guide
└── README.md
```

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Create environment configuration

```bash
cp .env.example .env
```

Fill in the Supabase and MQTT values. The service-role key is required even
when MQTT is disabled because the application creates its Supabase client at
startup.

For a local HTTP-only smoke test, set:

```dotenv
MQTT_ENABLED=false
```

### 3. Apply the database schema

Run the base statements in [`SQL.md`](./SQL.md), then run:

```text
supabase/migrations/002_device_members.sql
```

You can paste both into the Supabase SQL Editor or apply them with the
Supabase CLI. The migration assumes the base tables from `SQL.md` already
exist.

Then enable:

- Email authentication in Supabase Auth.
- Realtime for `public.devices`.
- Realtime for `public.dispense_sessions` only if the app needs live session
  history updates.

### 4. Start the API

Development mode with file watching:

```bash
pnpm dev
```

Production-style local run:

```bash
pnpm build
pnpm start
```

The default server address is `http://localhost:3000`.

### 5. Check the server

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{"ok":true}
```

OpenAPI JSON is available at `/docs/json`, and Swagger UI is available at
`/docs`.

For a complete setup, including how to obtain a Supabase JWT, connect a mobile
client, configure MQTT, and run the mock purifier, read [`GUIDE.md`](./GUIDE.md).

## Environment variables

The application validates its environment at startup with Zod and exits if a
required value is missing.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `NODE_ENV` | No | `development` | `development`, `test`, or `production`. |
| `PORT` | No | `3000` | HTTP port. |
| `HOST` | No | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | No | `info` | Fastify/Pino log level. |
| `SUPABASE_URL` | Yes | — | Project URL, for example `https://project.supabase.co`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | — | Server-only Supabase service-role key. Never expose it to a mobile app. |
| `MQTT_URL` | Yes | — | Broker URL, normally `mqtts://...:8883`. |
| `MQTT_USERNAME` | Yes | — | MQTT broker username. |
| `MQTT_PASSWORD` | Yes | — | MQTT broker password. |
| `MQTT_ENABLED` | No | `true` | Set to `false` for HTTP-only local smoke tests. |
| `DEVICE_ONLINE_WINDOW_MINUTES` | No | `5` | Maximum age of a device heartbeat for commands. |
| `COMMAND_RATE_LIMIT_MS` | No | `10000` | Minimum time between commands for one device. |
| `FILTER_ALERT_THRESHOLD_LITERS` | No | `50` | Filter low-life threshold. |
| `TANK_ALERT_THRESHOLD_ML` | No | `500` | Tank low-level threshold. |
| `FCM_SERVICE_ACCOUNT_PATH` | No | — | Reserved configuration for future FCM delivery. The current implementation logs alerts instead. |
| `DEVICE_ID` | Mock only | — | Device UUID used by `pnpm mock-rpi`. |
| `MOCK_RPI_INTERVAL_MS` | Mock only | `5000` | Mock publisher interval. |

Example:

```dotenv
NODE_ENV=development
PORT=3000
HOST=0.0.0.0
LOG_LEVEL=info

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=server-only-service-role-key

MQTT_URL=mqtts://your-cluster.s1.eu.hivemq.cloud:8883
MQTT_USERNAME=aquasense-backend
MQTT_PASSWORD=replace-me
MQTT_ENABLED=true

DEVICE_ONLINE_WINDOW_MINUTES=5
COMMAND_RATE_LIMIT_MS=10000
FILTER_ALERT_THRESHOLD_LITERS=50
TANK_ALERT_THRESHOLD_ML=500
```

## NPM scripts

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start `src/index.ts` with `tsx watch`. |
| `pnpm build` | Compile `src` to `dist`. |
| `pnpm start` | Run the compiled `dist/index.js`. |
| `pnpm typecheck` | Typecheck application, tests, and scripts. |
| `pnpm test` | Run the Node built-in test runner through `tsx`. |
| `pnpm mock-rpi` | Publish mock status and session telemetry to MQTT. |

## REST API

All application routes are under `/v1` and require:

```http
Authorization: Bearer <supabase-access-token>
```

The exceptions are:

- `GET /health`
- `/docs`
- `/documentation`

### Response and error format

Successful responses use the route-specific JSON shape. Errors use:

```json
{
  "error": {
    "code": "DEVICE_ACCESS_DENIED",
    "message": "You are not a member of this device",
    "details": {}
  }
}
```

Validation failures use `400` and `VALIDATION_ERROR`. Authentication failures
use `401`. Authorization failures use `403`. Device state conflicts such as an
offline or busy purifier use `409`.

### Health

```http
GET /health
```

Response:

```json
{"ok":true}
```

### List devices

```http
GET /v1/devices
```

Returns devices for which the current user has a `device_members` row. Each
device includes the caller's role.

### Claim a device

```http
POST /v1/devices/claim
Content-Type: application/json

{"device_id":"<device-uuid>"}
```

The device must exist and have a null `owner_id`. The database transaction
sets `devices.owner_id` and creates the caller's `owner` membership. A claimed
device returns `409 DEVICE_ALREADY_CLAIMED` to later claim attempts.

### List device members

```http
GET /v1/devices/:device_id/members
```

Any device member can view the member list. The response includes user ID,
email, display name, avatar URL, role, and membership creation time.

### Add a member by email

```http
POST /v1/devices/:device_id/members
Content-Type: application/json

{"email":"member@example.com","role":"member"}
```

The caller must be an owner. The target user must already have signed up so a
`profiles` row exists. Use `role: "owner"` to add another owner.

### Change a member role

```http
PATCH /v1/devices/:device_id/members/:user_id
Content-Type: application/json

{"role":"owner"}
```

The caller must be an owner. The current owner cannot demote themselves.

### Remove a member

```http
DELETE /v1/devices/:device_id/members/:user_id
```

The caller must be an owner and cannot remove themselves.

### Dashboard summary

```http
GET /v1/dashboard/:device_id
```

Returns the device snapshot and aggregation from `dashboard_summary`:

- `status`
- `tank_level_ml`
- `current_tds`
- `filter_life_liters`
- `firmware_version`
- `last_seen_at`
- `water_consumed_today_ml`
- `water_consumed_week_ml`
- `session_count_today`

The caller must be a device member. The database view uses the current device
row and dispense sessions, so it does not require multiple API round trips.

### List guest sessions

```http
GET /v1/sessions/guests?device_id=<device-uuid>&limit=25&before=<iso-timestamp>
```

Returns unassigned sessions (`user_id IS NULL`) newest first. `limit` defaults
to `25` and is capped at `100`. Use the returned `next_before` timestamp for
the next page.

### Assign a guest session

```http
PUT /v1/sessions/:id/assign
Content-Type: application/json

{"user_id":"<member-user-uuid>"}
```

The caller must own the session's device, and the target user must be a member
of that device. A session already assigned by another request returns
`409 SESSION_ALREADY_ASSIGNED`.

### Send a device command

```http
POST /v1/devices/:device_id/command
Content-Type: application/json

{"command":"flush"}
```

Allowed commands:

- `flush`
- `drain`
- `reboot`
- `update_firmware`

The command route checks, in order:

1. The caller is a device member.
2. `flush` and `drain` are issued by an owner.
3. The device has a recent heartbeat and is not `offline`.
4. `flush` and `drain` are not sent while the device is `dispensing` or
   `flushing`.
5. The device has not exceeded its in-memory command rate limit.

The route creates a `pending` command log, publishes the MQTT command, and
transitions the log to `delivered`. The Raspberry Pi must publish a command
acknowledgement to transition it to `completed` or `failed`.

## MQTT contract

The MQTT topic segments use the Supabase `devices.id` UUID. Do not use a
human-readable device name or a separate Raspberry Pi serial number in these
topics unless the contract is changed in both the backend and firmware.

### Backend subscriptions

The backend subscribes at startup with QoS 1 to:

```text
telemetry/status/+
telemetry/sessions/+
device/+/command_ack
```

Malformed JSON, invalid topics, and invalid payloads are logged and skipped so
one bad message does not poison the subscription.

### Status telemetry: Raspberry Pi → backend

Topic:

```text
telemetry/status/<device-uuid>
```

Payload:

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

Rules:

- `tds` and `tank_level_ml` are non-negative integers.
- `filter_life_liters` and `firmware_version` are optional.
- `status` is `offline`, `online`, `dispensing`, or `flushing`.
- `ts` must be an ISO timestamp with an offset.
- The device must already exist in Supabase.
- Older status messages than `last_telemetry_at` are ignored.
- Accepted messages update the device snapshot and last-seen timestamps.

### Dispense session telemetry: Raspberry Pi → backend

Topic:

```text
telemetry/sessions/<device-uuid>
```

Payload:

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "user_id": null,
  "start_ts": "2026-10-20T12:00:00.000Z",
  "end_ts": "2026-10-20T12:02:00.000Z",
  "volume_ml": 750,
  "avg_tds_out": 18,
  "temperature_c": 21.5
}
```

Rules:

- `id` is generated by the Raspberry Pi and is the idempotency key.
- `end_ts` is required because the backend stores completed sessions.
- `volume_ml` must be greater than zero.
- `user_id` is optional. Unknown or non-member users are stored as guests.
- The backend uses an `id` conflict-safe upsert, so batch retries do not
  create duplicate sessions.

### Device command: backend → Raspberry Pi

Topic:

```text
device/<device-uuid>/commands
```

Payload:

```json
{
  "command_id": "33333333-3333-4333-8333-333333333333",
  "command": "flush"
}
```

The Raspberry Pi must preserve and echo `command_id` in its acknowledgement.

### Command acknowledgement: Raspberry Pi → backend

Topic:

```text
device/<device-uuid>/command_ack
```

Payload:

```json
{
  "command_id": "33333333-3333-4333-8333-333333333333",
  "status": "completed"
}
```

`status` must be `completed` or `failed`. The backend only updates command
logs that are still `pending` or `delivered`, so a terminal acknowledgement
cannot be downgraded by a later REST update.

## Database contract

### Base tables from `SQL.md`

- `profiles`: one row per Supabase Auth user.
- `devices`: purifier identity, owner pointer, live snapshot, firmware, and
  last-seen data.
- `dispense_sessions`: completed water-dispense events keyed by the Raspberry
  Pi-generated UUID.
- `command_logs`: command audit trail and delivery lifecycle.

### Objects added by `002_device_members.sql`

- `profiles.email`
- `device_members(device_id, user_id, role)`
- `is_device_member(device_id, user_id)`
- `is_device_owner(device_id, user_id)`
- `claim_device(device_id, user_id)`
- `dashboard_summary`
- `last_telemetry_at` on `devices`
- Profile/Auth synchronization trigger
- Command `updated_at` trigger
- Device, session, command, membership, and profile indexes
- Membership-based RLS policies

### Migration ordering

The migration is intentionally separate from `SQL.md` because it changes the
initial owner-only policy model into the production membership model. Apply in
this order:

1. Base schema from `SQL.md`.
2. `supabase/migrations/002_device_members.sql`.
3. Supabase Auth and Realtime dashboard configuration.

The migration backfills profiles from existing `auth.users` rows and creates
memberships for existing non-null `devices.owner_id` values.

## Connecting a mobile/web client

The client needs two connections:

1. Supabase Auth/Realtime using the **anon or publishable key**.
2. The Fastify REST API using the Supabase user's access token.

Do not put `SUPABASE_SERVICE_ROLE_KEY` in the client.

### Sign in and call the API

Example with `@supabase/supabase-js`:

```ts
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
);

const { data, error } = await supabase.auth.signInWithPassword({
  email: 'owner@example.com',
  password: 'correct horse battery staple',
});

if (error) throw error;

const accessToken = data.session?.access_token;
const response = await fetch('http://localhost:3000/v1/devices', {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});

const devices = await response.json();
```

When the session refreshes, use the latest access token for subsequent API
requests. A stale or missing token returns `401 UNAUTHORIZED`.

### Subscribe to live device changes

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
      console.log('Live device update:', payload.new);
    },
  )
  .subscribe();

// On screen teardown:
await supabase.removeChannel(channel);
```

The Realtime publication must include `public.devices`. The backend does not
provide a WebSocket endpoint of its own.

## Running the demo flow

1. Create two Supabase Auth users: an owner and a member.
2. Apply the database schema and insert/register an unclaimed device.
3. Start the backend with MQTT enabled.
4. Sign in as the owner and copy the access token.
5. Claim the device through `POST /v1/devices/claim`.
6. Add the member by email.
7. Start `pnpm mock-rpi` with the registered device UUID.
8. Watch the dashboard update from status messages.
9. List guest sessions and assign one to the member.
10. Send `flush` as the owner.
11. Have the Raspberry Pi or a test MQTT client publish the command ACK.
12. Confirm the command log reaches `completed`.

The same sequence is prepared in [`docs/demo.http`](./docs/demo.http), which
works with VS Code REST Client and compatible HTTP clients. Replace the
variables at the top before running the requests.

### Mock Raspberry Pi

The mock publisher needs the same broker credentials as the backend and a
known device UUID:

```bash
DEVICE_ID=11111111-1111-4111-8111-111111111111 pnpm mock-rpi
```

It publishes an initial status and then publishes status plus a 250 ml session
at the configured interval. It does not emulate command acknowledgements; a
real firmware client or a separate MQTT test publisher must do that.

## Tests and verification

Run all checks:

```bash
pnpm typecheck
pnpm test
pnpm build
```

The current unit tests cover:

- Valid and invalid MQTT schemas.
- Invalid MQTT topic UUIDs.
- Malformed JSON that must not touch Supabase.
- Status updates through an in-memory Supabase boundary.
- Duplicate-safe session upsert options.
- Command acknowledgement updates.
- Member, owner, and unauthenticated access decisions.

The repository does not currently contain a live Supabase/Postgres integration
test or a live broker test. After applying the migration, manually verify:

- A member can see a shared device.
- A non-member cannot see it.
- Direct client RLS policies behave as intended.
- A status message updates the device row and emits Realtime.
- Repeating a session message leaves one session row.
- A command reaches the broker and its ACK reaches `completed`.

## Operational notes and limitations

### Service-role key

The backend intentionally uses the Supabase service-role key for ingestion and
server-side writes. Protect it as a secret, restrict access to the server
environment, and never include it in frontend configuration, logs, or demo
requests.

### MQTT access control

The application currently authenticates to the broker with one configured MQTT
credential. Configure broker ACLs so only the backend can subscribe to all
device topics and each device can publish/subscribe only to its own topics.
The topic UUID is validated, but it is not by itself cryptographic device
identity.

### FCM

`FCM_SERVICE_ACCOUNT_PATH` is accepted for future notification delivery, but
`src/lib/fcm.ts` currently logs alert fan-out rather than sending push
notifications. Do not describe FCM as active until the Firebase Admin SDK and
device-token storage are added.

### MQTT retries

The backend retries failed message processing a small number of times with
backoff. The Raspberry Pi should still retain events locally and republish
unacknowledged messages, as described in the product plan. The session UUID
makes those retries safe.

### Realtime

Supabase Realtime is the live dashboard transport. Fastify writes the database
row; the client listens to Supabase. Do not add a second Fastify WebSocket
layer unless the product requirements change.

## Related documents

- [`GUIDE.md`](./GUIDE.md): detailed setup and connection walkthrough.
- [`IDEA.md`](./IDEA.md): original architecture and product idea.
- [`PLAN.md`](./PLAN.md): phased implementation plan and decisions.
- [`SQL.md`](./SQL.md): base Supabase schema and original policies.
- [`supabase/migrations/002_device_members.sql`](./supabase/migrations/002_device_members.sql): membership migration and current RLS contract.
- [`docs/demo.http`](./docs/demo.http): REST Client demo sequence.
