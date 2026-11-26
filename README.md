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
- FCM delivery requires a service account and registered mobile tokens.

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

- `owner`: manages members and can request a drain.
- `member`: views shared devices, sessions, and command history.

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
supabase/migrations/003_edge_v1.sql
supabase/migrations/004_arduino_dispenses.sql
```

You can paste these into the Supabase SQL Editor or apply them with the
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
| `MQTT_URL` | With MQTT enabled | — | Broker URL, normally `mqtts://...:8883`. |
| `MQTT_USERNAME` | With MQTT enabled | — | MQTT broker username. |
| `MQTT_PASSWORD` | With MQTT enabled | — | MQTT broker password. |
| `MQTT_ENABLED` | No | `true` | Set to `false` for HTTP-only deployments. |
| `AQUASENSE_DEVICE_TOKENS` | With Arduino HTTPS delivery | `{}` | Secret JSON object mapping device UUIDs to distinct bearer tokens. |
| `DEVICE_ONLINE_WINDOW_MINUTES` | No | `5` | Maximum age of a device heartbeat for commands. |
| `COMMAND_RATE_LIMIT_MS` | No | `10000` | Minimum time between commands for one device. |
| `DRAIN_MAX_DURATION_S` | No | `15` | Maximum accepted drain duration in seconds (up to 15). |
| `MQTT_CA_PATH` | No | — | PEM CA certificate for private brokers. |
| `FCM_SERVICE_ACCOUNT_PATH` | No | — | Firebase service account JSON for mobile alert delivery. |
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
- `tank_state` and `telemetry` (including sensor quality and reading timestamps)
- `filter_usage_ml` (sum from calibrated sessions)
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

### Request a drain

```http
POST /v1/devices/:device_id/command
Content-Type: application/json
Idempotency-Key: <unique-key-for-this-confirmed-request>

{"command":"drain","duration_s":5,"confirmed":true}
```

Only owners can request a drain. The app sends this request after explicit user
confirmation. The response is `202` with the command ID and current status.
Reuse the same key and request body on HTTP retry. A changed duration with the
same key returns `409`. Each command has a 15-second dispatch window.

Members can call `GET /v1/devices/:device_id/commands/:command_id` for expiry,
broker delivery time, and the Pi's ordered lifecycle history. Broker delivery
and valve command state are separate from the Pi's acceptance and from physical
drainage. A pending command past its expiry has an unconfirmed outcome.

### Register for mobile alerts

Send `PUT /v1/notifications/token` with `{"token":"<fcm-token>"}` using the
user's bearer token. Send `DELETE` with the same body on sign-out or token
replacement. Configure `FCM_SERVICE_ACCOUNT_PATH` to send alerts. Use
`event_id` from the FCM data payload to deduplicate delivery on the client.

## MQTT contract

Use the registered `devices.id` UUID in `purifier/{device_id}/...` and verified
`mqtts://` for both backend and edge connections.

| Suffix | Direction | QoS | Purpose |
| --- | --- | --- | --- |
| `events` | Pi → backend | 1 | Dispense sessions and alert transitions |
| `telemetry` | Pi → backend | 0 | Threshold tank, sensors, health |
| `ack` | Pi → backend | 1 | Command lifecycle revisions |
| `status` | Pi → backend | 1 | Retained availability and LWT |
| `events_ack` | Backend → Pi | 1 | Event revision committed to Postgres |
| `cmd` | Backend → Pi | 1 | Expiring drain request, non-retained |

Configure each Pi credential to publish and subscribe only to its assigned
directions and UUID. Reserve publishing `cmd` and `events_ack` for the backend.
Clear old retained commands before allowing device subscriptions at cutover.
Deploy the migration before starting version 1 consumers. Switch the edge and
backend topics together and update app response handling for threshold tank
state, nullable readings and fractional volumes. See [BACKEND.md](BACKEND.md)
for the payload contract.

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
3. `supabase/migrations/003_edge_v1.sql`.
4. `supabase/migrations/004_arduino_dispenses.sql`.
5. Supabase Auth and Realtime dashboard configuration.

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
10. Send a confirmed drain request as the owner.
11. Confirm receipt and rejection with reason `actuation_disabled`.

The same sequence is prepared in [`docs/demo.http`](./docs/demo.http), which
works with VS Code REST Client and compatible HTTP clients. Replace the
variables at the top before running the requests.

### Mock Raspberry Pi

The mock publisher needs dedicated device broker credentials and a
known device UUID:

```bash
DEVICE_ID=11111111-1111-4111-8111-111111111111 pnpm mock-rpi
```

It publishes retained availability, telemetry, and fractional sessions. It
retries unacknowledged revisions in memory and simulates drain rejection.

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
- A simulated drain reaches the Pi and its received and rejected revisions commit.

Run `psql -v ON_ERROR_STOP=1 -f test/edge-v1.sql` against a migrated test database for commit, revision, drain and outbox assertions. The fixtures roll back.

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

### Delivery monitoring

Watch backend logs for failed commits, commit ACKs, and dispatch attempts.
In Postgres, monitor expired pending `command_logs`, unexpanded
`alert_outbox` rows and unfinished `alert_deliveries`. If FCM credentials
are absent, alert jobs remain queued.

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
