# AquaSense Backend — Implementation Plan

Stack: **Fastify + TypeScript (ESM, Node 20+) + Supabase (Postgres, Auth, Realtime) + MQTT (HiveMQ Cloud)**.
Validation: **Zod** via `fastify-type-provider-zod`. Package manager: **pnpm**.

Decisions locked in (2026-10-19): full 5-phase scope, HiveMQ Cloud broker, Zod validation.
**Phase 1 update:** base schema + RLS already deployed (see `SQL.md`). This plan is aligned to that schema plus the membership extension below.

---

## Schema reality check (SQL.md + 002_device_members.sql — this is the contract)

- `profiles`: `id (uuid, = auth.users)`, `display_name`, `avatar_url`, plus **added `email`** (needed for owner-adds-member-by-email). A `handle_new_user` trigger on `auth.users` auto-creates the profile row at signup.
- **`device_members` (new)**: `(device_id, user_id)` PK, `role ∈ (owner, member)`. This — not a column on `profiles` — is where roles live, because role is per-(user, device): someone can own one purifier and be a member of another. "How the owner is connected to the device" = the membership row with `role='owner'`, created at claim time.
- `devices`: `id uuid` (Supabase-generated — MQTT topics carry this UUID), `owner_id` (kept as primary-owner pointer, set at claim), `name`, `status ∈ (offline, online, dispensing, flushing)`, `tank_level_ml int`, `current_tds int`, `filter_life_liters numeric`, `firmware_version`, `last_seen_at`.
- `dispense_sessions`: `id uuid PK = idempotency key generated on the RPi`, `device_id`, `user_id null = Guest`, `volume_ml int > 0`, `avg_tds_out`, `temperature_c`, `start_ts`, `end_ts` (both NOT NULL — RPi sends completed sessions).
- `command_logs`: `id uuid`, `device_id`, `issued_by`, `command ∈ (flush, drain, reboot, update_firmware)`, `status ∈ (pending, delivered, completed, failed)`.
- **RLS is membership-based** via `is_device_member(device_id)` / `is_device_owner(device_id)` — both `SECURITY DEFINER` functions (a policy on `device_members` referencing `device_members` directly would infinitely recurse; the functions bypass RLS and avoid that).
- Client writes allowed by RLS: profile self-update, device update (owner), session reassignment (owner), command insert (any member), member management (owner). **Telemetry ingestion and command-status transitions still go through Fastify's service-role key.**

## Guiding constraints (hackathon mode)

- One Node process wears two hats: REST API + MQTT subscriber/publisher. No separate worker.
- Live app updates come from **Supabase Realtime** (on `devices`), not Fastify websockets. Fastify only writes to the DB.
- Idempotency: the RPi generates the session `id` (uuid); ingestion uses `onConflict: 'id', ignoreDuplicates: true` so RPi batch retries can't double-count volume.
- Every route and MQTT payload has a Zod schema → Swagger UI at `/docs` for free (judge-friendly).

---

## Phase 0 — Project scaffold

**Goal:** `pnpm dev` boots a typed Fastify server with hot reload.

Steps:
1. `pnpm add fastify @fastify/cors @fastify/helmet @fastify/swagger @fastify/swagger-ui zod fastify-type-provider-zod @supabase/supabase-js mqtt dotenv`
2. `pnpm add -D typescript tsx @types/node`
3. `tsconfig.json`: `module: NodeNext`, `moduleResolution: NodeNext`, `strict: true`, `target: ES2022`, `outDir: dist`. (ESM is already in package.json; relative TS imports need `.js` extensions.)
4. Scripts: `dev: tsx watch src/index.ts`, `build: tsc`, `start: node dist/index.js`.
5. Folder layout:

```
src/
  index.ts            # entry: build server, listen
  app.ts              # buildApp(): registers plugins + routes (testable)
  config.ts           # env parsing via zod (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD, PORT)
  plugins/
    supabase.ts       # fastify-plugin: decorates app.supabase (service-role client)
    auth.ts           # onRequest hook: Bearer JWT -> supabase.auth.getUser -> request.user
    mqtt.ts           # fastify-plugin: onReady connect/subscribe, onClose quit; decorates app.mqtt
  modules/
    devices/routes.ts # incl. claim + member management
    sessions/routes.ts
    dashboard/routes.ts
  ingestion/
    handlers.ts       # telemetry + command-ack handlers
    schemas.ts        # zod schemas for MQTT payloads (THE contract with the RPi)
  lib/
    access.ts         # getMembership / requireMember / requireOwner helpers
    fcm.ts            # push-notification helper (stubbed until Phase 3)
```

6. `.env.example` committed; `.env` gitignored. `config.ts` fails fast on missing vars.

**Exit check:** `pnpm dev` → `GET /health` returns `{ ok: true }`; Swagger UI renders at `/docs`.

---

## Phase 1 — Database finishing touches (base schema already deployed)

**Goal:** apply the membership migration + gaps; make the demo dataset real.

1. **Apply `002_device_members.sql`** (full SQL agreed on 2026-10-19):
   - `device_members(device_id, user_id, role ∈ owner|member)` with PK `(device_id, user_id)`
   - `is_device_member()` / `is_device_owner()` SECURITY DEFINER helpers
   - `profiles.email` + `handle_new_user` trigger on `auth.users`
   - Backfill existing `devices.owner_id` owners into `device_members`
   - Replace owner_id-only RLS policies with membership-based ones (devices, sessions, command_logs, device_members itself)
2. **Indexes** (SQL.md shipped none) — fold into the same migration:
   - `dispense_sessions(device_id, start_ts desc)` — dashboard + history
   - partial `dispense_sessions(device_id) where user_id is null` — guest-sessions screen
   - `command_logs(device_id, created_at desc)` — audit trail
   - `profiles(email)` — member lookup by email
3. **Realtime:** enable the publication for `devices` in the dashboard (powers the live dashboard). Add `dispense_sessions` only if the app live-updates history.
4. **Auth:** enable Email provider (Google OAuth only if time allows). App uses anon key + user JWT; Fastify uses the **service-role** key, server-side only.
5. **Role semantics** (enforce in Fastify, RLS is the backstop):
   - `owner`: manage members (add/edit role/remove), update device settings, all commands incl. `drain`/`flush`, reassign guest sessions
   - `member`: view dashboard/sessions, claim guest sessions to self, issue commands (all four are fine for a household — no per-role command gating for now)
6. **Seed data:** two users (owner + member), one device with a known UUID (goes to the firmware teammate for MQTT topics), the membership rows, ~20 historical sessions (a few with `user_id null` for the guest flow).

**Exit check:** RLS spot-check — member sees the shared device but can't edit roles; a non-member sees nothing; manual `UPDATE devices SET current_tds...` fires a Realtime event.

---

## Phase 2 — Fastify core

**Goal:** typed, documented, secure HTTP layer with Supabase available everywhere.

Steps:
1. `plugins/supabase.ts`: one service-role client (`auth: { persistSession: false }`), decorate `fastify.supabase`. Service role bypasses RLS, so **authorization lives in code**: `lib/access.ts` provides `getMembership(userId, deviceId)` → `requireMember` / `requireOwner` helpers that every device-scoped route calls first.
2. `plugins/auth.ts`: `onRequest` preHandler reading `Authorization: Bearer <jwt>` → `supabase.auth.getUser` → `request.user`. 401 on failure. Skip for `/health` and `/docs`.
3. Zod provider: `setValidatorCompiler` / `setSerializerCompiler` from `fastify-type-provider-zod`. Every route declares `schema: { body, params, querystring, response }` — feeds Swagger automatically.
4. `@fastify/helmet`, `@fastify/cors` (`origin: true` for hackathon), `@fastify/swagger` + `@fastify/swagger-ui` at `/docs`.
5. Central `setErrorHandler`: `ZodError` → 400 with field details; known app errors → their status; else 500 + log. Uniform shape `{ error: { code, message, details? } }`.

**Exit check:** a dummy authenticated route returns the caller's profile + memberships; invalid bodies get clean 400s; Swagger shows schemas.

---

## Phase 3 — MQTT ingestion engine (HiveMQ Cloud)

**Goal:** RPi telemetry flows into Postgres idempotently; alerts trigger push notifications; command ACKs close the loop.

### 3.1 Connection lifecycle (`plugins/mqtt.ts`)

- HiveMQ Cloud over TLS: `mqtts://<cluster>.s1.eu.hivemq.cloud:8883` + username/password from env.
- Connect in `onReady`; subscribe (QoS 1) to:
  - `telemetry/status/+`
  - `telemetry/sessions/+`
  - `device/+/command_ack` — the RPi confirms command execution (the `command_logs.status` lifecycle exists, so we should feed it)
- `onClose` → `client.end()`. Log `reconnect`/`error`. Expose `app.mqtt.publish(...)` for Phase 4.

### 3.2 Ingestion handlers (`ingestion/`)

Zod schemas (this file is the contract shared with firmware on day one):

- `telemetry/status/:deviceUuid` → `{ tds: int, tank_level_ml: int, filter_life_liters?: number, status: enum, firmware_version?: string, ts: string }` → upsert `devices` (`current_tds`, `tank_level_ml`, `status`, `last_seen_at = now()`). **Unknown device UUID → log a warning and skip** (devices are pre-registered; no auto-provisioning — `devices.id` is DB-generated).
- `telemetry/sessions/:deviceUuid` → `{ id: uuid, user_id?: uuid, start_ts, end_ts, volume_ml: int>0, avg_tds_out?: int, temperature_c?: number }` → insert with `onConflict: 'id', ignoreDuplicates: true`. This is the retry-safety guarantee.
- `device/:deviceUuid/command_ack` → `{ command_id: uuid, status: 'completed' | 'failed' }` → update `command_logs.status` + `updated_at`.
- Malformed payloads: `safeParse`; on failure log topic + raw payload and ack anyway — never poison the subscription.

### 3.3 Alerts → FCM (`lib/fcm.ts`)

- After a status upsert: if `filter_life_liters` dropped below a threshold (e.g. 50 L) or `tank_level_ml` is critically low, call `notify(deviceId, alert)` → fans out to **all members** of the device.
- `firebase-admin` SDK from a service-account path in env, behind a thin interface that **logs instead of sending when credentials are absent** — the demo must never hard-depend on FCM.

**Exit check:** publish a status message → `devices` row updates + Realtime fires; publish the same session payload twice → exactly one row; publish a `command_ack` → the log row flips to `completed`.

---

## Phase 4 — REST endpoints for the mobile app

All under `/v1`, all authenticated except `/health`.

**Devices & membership:**
1. `GET /v1/devices` — every device where the caller has a membership row, with their role (app home screen).
2. `POST /v1/devices/claim` — body `{ device_id }` (from the QR code on the purifier). Reject 409 if already claimed. In one transaction: set `devices.owner_id = caller` + insert `device_members(..., 'owner')`. **This is how the owner connects to the device.**
3. `GET /v1/devices/:device_id/members` — member list w/ roles (member can view).
4. `POST /v1/devices/:device_id/members` — owner only; body `{ email, role }`; look up profile by email (404 → "they must sign up first"), upsert membership. **This is how new users join the device.**
5. `PATCH /v1/devices/:device_id/members/:user_id` — owner only; change `role`. (Owner promoting a member to `owner` = multi-owner household.)
6. `DELETE /v1/devices/:device_id/members/:user_id` — owner only; can't remove yourself (use a leave endpoint later if needed — skip for hackathon).

**Data & control:**
7. `GET /v1/dashboard/:device_id` — member check, then a single Postgres query/view (`dashboard_summary`): water consumed today/this week, session count, latest `devices` snapshot (`current_tds`, `tank_level_ml`, `filter_life_liters`, `status`). One round-trip, not N.
8. `GET /v1/sessions/guests?device_id=` — sessions with `user_id is null` on member devices, newest first, paginated on `start_ts`.
9. `PUT /v1/sessions/:id/assign` — body `{ user_id }`; owner only; `UPDATE ... WHERE id = ? AND user_id IS NULL` → 409 if 0 rows (already claimed).
10. `POST /v1/devices/:device_id/command` — body `{ command: 'flush' | 'drain' | 'reboot' | 'update_firmware' }` (exactly the CHECK constraint). Guards, in order:
    - caller is a member (403); `drain`/`flush` additionally require `owner` (403)
    - device is online: `last_seen_at` within N minutes AND `status != 'offline'` (409)
    - **interlock:** reject `flush`/`drain` while `status = 'dispensing'` or `'flushing'` (409)
    Then: insert `command_logs` (`status: 'pending'`, `issued_by = caller`) → publish to `device/:device_id/commands` with the log row's uuid as `command_id` → mark `delivered` → return `{ command_id, status: 'delivered' }`. The ack topic (Phase 3) takes it to `completed`/`failed`.

**Exit check:** full loop against the real broker — claim a device with user A, add user B by email, B sees the device in `GET /v1/devices` → owner sends command → `pending` row → MQTT message on `device/+/commands` → ack → `completed`; all visible in `/docs`.

---

## Phase 5 — Hackathon polish (time-boxed, priority order)

1. **Command rate limiting:** 1 command per device per 10s — survives demo-day button mashing (in-memory map is fine).
2. **Judge demo script:** `docs/demo.http` (REST Client format) walking the story: signup → claim device (QR) → add family member → telemetry in → live dashboard → guest session → claim it → flush command → ack.
3. **Aggregation:** `dashboard_summary` as a plain Postgres view; upgrade to a materialized view + cron refresh **only if measured slow**.
4. **Mock RPi publisher** (`scripts/mock-rpi.ts`): publishes status + sessions on a timer — lets the app team demo without hardware on stage.
5. Nice-to-haves only if ahead: Docker Compose (app + local Mosquitto fallback), GitHub Action running `tsc --noEmit`.

---

## Risks & fallbacks

- **Venue WiFi vs HiveMQ Cloud** → broker URL is an env var; Mosquitto-in-Docker fallback config ready.
- **Service role bypasses RLS** → every device-scoped route starts with `requireMember`/`requireOwner` from `lib/access.ts`; no ad-hoc checks.
- **Recursive RLS on device_members** → already handled: membership checks live in SECURITY DEFINER functions. If policies are ever written without them, expect `infinite recursion detected in policy` errors.
- **Email lookup for adding members** requires the target to have signed up already (profile row must exist) — the 404 message should say exactly that.
- **FCM setup is fiddly** → `notify()` stubs to logs until credentials are wired in last.
- **RPi contract drift** → `ingestion/schemas.ts` IS the contract; share it with the firmware teammate on day one. Note the specifics they'll care about: topic segments are the **Supabase device UUID**, sessions must include `end_ts`, and `command_id` in ACKs must echo what we publish.

## Definition of done (demoable)

User signs up → claims a device via QR → adds a family member by email (member sees the device instantly) → mock or real RPi streams status + sessions → the app's Realtime dashboard updates live → guest sessions get claimed → owner taps "Flush" → command logged (`pending → delivered → completed`) and delivered over MQTT → all explorable in `/docs`.
