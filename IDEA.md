Fastify, TypeScript, Node.js, and Supabase is a highly optimized, developer-friendly stack that will easily handle the throughput of IoT telemetry while serving a snappy API for the app.

Here is how we can architect the backend for maximum efficiency, leaning on Supabase's native features to save you time during the hackathon.

### Architectural Brainstorm: Efficiency Wins

1. **The MQTT-to-Database Bridge (The Node/Fastify Layer)**
Your Fastify server will wear two hats:
* **REST API:** Serving standard HTTP requests for the mobile app (historical data, user profiles, resolving "Guest" profiles).
* **MQTT Subscriber:** On startup, the Node process connects to your MQTT broker (like HiveMQ or Mosquitto). It listens to topics like `device/+/telemetry` and `device/+/events`. When a message arrives, it validates the payload and writes it directly to Supabase.


2. **Free Real-Time App Updates (Supabase Magic)**
Instead of building websockets in Fastify to send live tank/TDS updates to the mobile app, use **Supabase Realtime**.
* RPi publishes telemetry via MQTT -> Fastify writes to Supabase `devices` table -> App listens to Supabase Realtime for changes to that row.
* *Result:* You get a live dashboard in the app with zero extra backend routing.


3. **Idempotent Ingestion**
Since the RPi uses local SQLite and uploads in batches if WiFi drops, the backend must handle retries gracefully. Generate a `uuid` for every event *on the Raspberry Pi*. In Supabase, make `event_id` the Primary Key. If Fastify tries to insert a duplicate event from a retry, the DB will safely reject it (or upsert), preventing duplicate volume data.
4. **Command Dispatch (App -> Backend -> RPi)**
When the admin taps "Flush Filter" in the app, the app hits a Fastify endpoint (`POST /devices/:id/command`). Fastify validates the user's admin role, logs the command in a `command_logs` table, and publishes the MQTT message to `device/{id}/commands`.

---

### Implementation Plan

#### Phase 1: Database & Auth Setup (Supabase)

Keep the schema relational and strictly typed.

* **Tables needed:**
* `profiles`: Links to Supabase Auth (Users/Admins).
* `devices`: `id`, `owner_id`, `current_tds`, `tank_level`, `status`, `last_seen`.
* `dispense_sessions`: `event_id` (PK from RPi), `device_id`, `user_id` (nullable for Guests), `start_ts`, `volume_ml`, `avg_tds`.
* `command_logs`: Audit trail of who triggered what.


* **Auth:** Set up Supabase Auth for the mobile app (Email/Password or OAuth). Secure the tables using Row Level Security (RLS) so users only see their own device data.

#### Phase 2: Fastify + TypeScript Boilerplate

* Initialize Fastify with `@fastify/cors`, `@fastify/helmet`, and `@fastify/swagger` (having auto-generated API docs is a huge flex for hackathon judges).
* Set up TypeBox or Zod for request validation. Fastify compiles these schemas into highly optimized validation functions.
* Initialize the `@supabase/supabase-js` client inside a Fastify plugin so it's accessible across your routes.

#### Phase 3: The MQTT Ingestion Engine

* Integrate the `mqtt` npm package.
* Create a Fastify hook (`fastify.addHook('onReady', ...)`) that establishes the MQTT connection.
* **Topics to subscribe to:**
* `telemetry/status/#` -> Updates the `devices` table (TDS, Tank level, online status).
* `telemetry/sessions/#` -> Inserts into `dispense_sessions`.


* Add logic to trigger Firebase Cloud Messaging (FCM) notifications if a payload contains an alert flag (e.g., `filter_life < 5%`).

#### Phase 4: Mobile App REST Endpoints

Build out the core routes required by the app:

* `GET /dashboard/:device_id` (Aggregated stats: total water consumed today, filter life).
* `GET /sessions/guests` (Fetch unassigned dispense sessions).
* `PUT /sessions/:event_id/assign` (Update a guest session with a known `user_id`).
* `POST /devices/:device_id/command` (Dispatch MQTT commands like `flush`, `drain`).

#### Phase 5: The "Hackathon Polish"

* **Edge-case handling:** Add logic to block remote commands (like drain) if the `devices` table indicates the status is currently `dispensing`.
* **Caching (Optional):** If dashboard aggregations (e.g., "Water consumed this month") get slow, you can use Supabase Database Webhooks to update a materialized view, keeping the Fastify API lightning fast.
