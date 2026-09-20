# Lyzr Outbound Voice Service

Outbound AI phone calls for Lyzr demo-form leads. Receives lead context from a
Lyzr SuperFlow, places a Twilio call, and bridges the prospect's audio to the
existing **LYZR Demo SDR** voice agent so it can check real Google Calendar
availability and book a meeting during the call.

---

## A. Overview

Two call modes share one endpoint (`POST /api/call`) and one telephony path:

| Mode | Meaning | Agent behaviour |
|---|---|---|
| `booking` | Lead submitted the demo form, has **no** meeting | Discovery → `FIND_FREE_SLOTS` → offer real slots → `CREATE_EVENT` → confirm |
| `confirmation` | Lead **already has** a meeting | State the booked time → confirm → capture one prep question |

The Lyzr agent owns the conversation and the calendar tools. This service owns
telephony, the audio bridge, and call lifecycle state. It does **not**
reimplement Google Calendar booking.

## B. Architecture

```
Lyzr SuperFlow
  └─ POST /api/call ──────────────►  THIS SERVICE (single Railway process)
                                       │
                                       ├─ 1. validate lead (zod, E.164)
                                       ├─ 2. clone base agent + inject context
                                       ├─ 3. VERIFY calendar tools ── missing? ─► 422, no call placed
                                       ├─ 4. persist call record
                                       └─ 5. Twilio calls.create(inline TwiML)
                                                │
   prospect answers ◄───────────────────────────┘
        │
        └─ Twilio Media Stream (WSS, μ-law 8 kHz)
              │
              ▼
        WS /twilio-media ──► AudioBridge ──► LiveKit room (Lyzr-dispatched agent)
          μ-law 8k → PCM16 8k → resample → PCM16 24k → AudioSource.captureFrame
                                                    (published as SOURCE_MICROPHONE)
          μ-law 8k ← PCM16 8k ← resample ← PCM16 @ agent's own rate (48k observed)
                                                    (subscribed remote agent track)
              │
              └─ Lyzr agent → GOOGLECALENDAR_FIND_FREE_SLOTS / CREATE_EVENT

  Twilio status webhooks ──► POST /api/twilio/status ──► state machine
  terminal status ─────────► POST SUPERFLOW_CALLBACK_URL
```

## C. What remains in SuperFlow

SuperFlow stays the business-orchestration layer:

- Form / webhook intake
- HubSpot create/update
- Existing-meeting lookup and `meeting_found` branch
- Setting `call_mode`
- **After the call**: fetch transcript, LLM summary, Gmail send

## D. What this Railway service handles

Lead validation · per-call agent preparation · calendar-tool verification ·
Twilio dialling · the bidirectional audio bridge · call state · idempotency ·
status webhooks · completion callback.

## E. Prerequisites

- Node.js 22+ (Node 24 tested)
- A Twilio account with a voice-capable number
- A Lyzr Voice Agent API key and the base agent id
- PostgreSQL in production (Railway provides it)

## F. Required environment variables

See [`.env.example`](.env.example) for the annotated list.

**Required in production:** `PORT` · `PUBLIC_BASE_URL` · `LYZR_API_KEY` ·
`LYZR_BASE_AGENT_ID` · `TWILIO_ACCOUNT_SID` · `TWILIO_AUTH_TOKEN` ·
`TWILIO_PHONE_NUMBER` · `SUPERFLOW_SHARED_SECRET` · `DATABASE_URL`

Startup fails loudly and lists **every** missing variable at once. Empty strings
count as unset, so a half-filled `.env` cannot start a partially-configured
service.

## G. Rotating the Lyzr API key safely

The key is only ever read from `LYZR_API_KEY` and sent as the `x-api-key`
header. It is never persisted, never returned by an endpoint, and never logged —
`src/utils/logging.ts` redacts it by path, and secrets are only ever printed as
truncated fingerprints. To rotate: update the Railway variable and redeploy.
Never commit a real key; `.env` is gitignored.

## H. Twilio setup

1. Buy or select a voice-capable number (current: `+16263133414`).
2. Set it as `TWILIO_PHONE_NUMBER`.
3. No console webhook configuration is needed — TwiML is supplied inline per
   call, and the status callback URL is set on each `calls.create`.
4. Keep `TWILIO_VALIDATE_WEBHOOKS=true` so status callbacks are signature-checked.

## I. Local install

```bash
npm install
cp .env.example .env     # fill in, or just set MOCK_EXTERNAL_SERVICES=true
npm run typecheck && npm test && npm run lint && npm run build
```

## J. Database setup

- **Production:** set `DATABASE_URL` to a `postgres://` URL. Schema is created
  automatically at startup (`CREATE TABLE IF NOT EXISTS`).
- **Local:** leave `DATABASE_URL` unset for an in-memory SQLite database, or use
  `sqlite:/tmp/dev.db` to persist between restarts.

## K. Mock test

`MOCK_EXTERNAL_SERVICES=true` stubs Lyzr agent preparation and Twilio dialling,
so the whole HTTP and state workflow runs with **no real phone call**. Mock mode
is logged loudly at startup and is rejected in production without credentials.

```bash
MOCK_EXTERNAL_SERVICES=true SUPERFLOW_SHARED_SECRET=dev-secret \
  LYZR_BASE_AGENT_ID=6aa13809b4c51e185bbca6ba TWILIO_PHONE_NUMBER=+16263133414 \
  PUBLIC_BASE_URL=http://localhost:3000 PORT=3000 npm start
```

Then the single mock curl:

```bash
curl -s -X POST http://localhost:3000/api/call \
  -H "Authorization: Bearer dev-secret" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: mock-lead-001" \
  -d '{"phone":"+919999999999","first_name":"Apoorva","last_name":"VH",
       "email":"apoorva@example.com","company":"Acme",
       "use_case":"AI agent for customer support","call_mode":"booking",
       "timezone":"Asia/Kolkata","meeting_booked":false}'
```

## L. Real test call

Deploy with real credentials, then call **your own number**:

```bash
curl -s -X POST https://<RAILWAY_DOMAIN>/api/call \
  -H "Authorization: Bearer $SUPERFLOW_SHARED_SECRET" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: real-test-001" \
  -d '{"phone":"+91XXXXXXXXXX","first_name":"Apoorva","last_name":"VH",
       "email":"you@yourdomain.com","company":"Lyzr",
       "use_case":"testing the outbound agent","call_mode":"booking",
       "timezone":"Asia/Kolkata","meeting_booked":false}'
```

Track it with `GET /api/calls/<call_id>`.

## M. Railway deployment

1. Create a Railway project from this repo (the `Dockerfile` is detected via
   `railway.json`).
2. Add the **PostgreSQL** plugin — `DATABASE_URL` is injected automatically.
3. Set the variables from section F. `PUBLIC_BASE_URL` must be the service's own
   public `https://` domain.
4. Deploy. Healthcheck is `/health`; readiness (including a DB round-trip) is
   `/ready`.

HTTP and WebSocket share one port and one process — no serverless functions, and
the server binds `0.0.0.0:$PORT`.

## N. SuperFlow configuration

Both branches POST to the same URL with the same headers:

```
POST https://<RAILWAY_DOMAIN>/api/call
Authorization:   Bearer <SUPERFLOW_SHARED_SECRET>
Content-Type:    application/json
Idempotency-Key: <unique form submission / lead execution ID>
```

`Idempotency-Key` is enforced by a database unique constraint. A retry returns
the original call and creates **no** second agent and **no** second phone call.

## O. Booking branch (`meeting_found = false`)

Code node: `({ ...$json, call_mode: "booking", meeting_booked: false })`

```json
{
  "phone": "{{ $('Trigger').json.phone }}",
  "first_name": "{{ $('Trigger').json.first_name }}",
  "last_name": "{{ $('Trigger').json.last_name }}",
  "email": "{{ $('Trigger').json.email }}",
  "company": "{{ $('Trigger').json.company }}",
  "use_case": "{{ $('Trigger').json.use_case }}",
  "call_mode": "booking",
  "timezone": "Asia/Kolkata",
  "meeting_booked": false,
  "meeting_id": null,
  "meeting_start": null,
  "meeting_end": null,
  "meeting_link": null,
  "meeting_owner": null
}
```

## P. Confirmation branch (`meeting_found = true`)

Code node: `({ ...$json, call_mode: "confirmation", meeting_booked: true })`

```json
{
  "phone": "{{ $('Trigger').json.phone }}",
  "first_name": "{{ $('Trigger').json.first_name }}",
  "last_name": "{{ $('Trigger').json.last_name }}",
  "email": "{{ $('Trigger').json.email }}",
  "company": "{{ $('Trigger').json.company }}",
  "use_case": "{{ $('Trigger').json.use_case }}",
  "call_mode": "confirmation",
  "timezone": "Asia/Kolkata",
  "meeting_booked": true,
  "meeting_id": "{{ $json.meeting_id }}",
  "meeting_start": "{{ $json.meeting_start }}",
  "meeting_end": "{{ $json.meeting_end }}",
  "meeting_link": "{{ $json.meeting_link }}",
  "meeting_owner": "{{ $json.meeting_owner }}"
}
```

`meeting_booked: true` and `meeting_start` are **required** in this mode.
Missing `meeting_link` or `meeting_owner` does not fail the request.

### Rescheduling honesty

No event-update/reschedule tool is attached to the base agent, and
`DELETE_EVENT` is **not** used as a substitute. If a prospect wants a different
time, the service records `reschedule_required` and
`preferred_replacement_slot` for SuperFlow to act on. The agent must not claim a
meeting was moved.

## Q0. Demo-calendar check and booking (service account)

All demo bookings live on the `demos@lyzr.ai` calendar. Nobody can OAuth into
that mailbox from SuperFlow or Composio, so this service holds one Google
Workspace **service account** with Domain-Wide Delegation and impersonates
`demos@lyzr.ai` for everything calendar-related. Credentials never leave the
backend; SuperFlow and the voice agent only ever see a URL and the shared
bearer secret.

```
Lead arrives in SuperFlow
        │
        ▼
POST /check-demo-booking            ← service account reads demos@lyzr.ai
        │
   already_booked?
   ├── null (error)  → STOP: never call in the wrong mode
   ├── true          → POST /api/call  call_mode=confirmation (+ meeting_* fields)
   └── false         → POST /api/call  call_mode=booking
                            │
                       voice agent on the call
                            ├── POST /demo-slots   ← free/busy on demos@lyzr.ai
                            └── POST /book-demo    ← events.insert + Meet link,
                                                      invite emailed to the lead
```

### Google Workspace prerequisites

1. Service account in the Cloud project, Calendar API enabled.
2. Admin console → Security → API controls → Domain-wide delegation → add
   the service account's **client ID** with the scope
   `https://www.googleapis.com/auth/calendar`. All three endpoints use this
   one scope (Google only issues tokens for scopes delegated verbatim, so the
   read check shares it rather than requiring `calendar.readonly` as well).
3. Set `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY` (single line with
   `\n`), `GOOGLE_PRIVATE_KEY_ID`, `GOOGLE_CLIENT_ID`,
   `GOOGLE_IMPERSONATED_USER=demos@lyzr.ai` on Railway.

### SuperFlow: replacing the Google Calendar Tool node

The workflow keeps its shape — `Trigger → check → Code → If → (Code 1 → HTTP
Request 1 | Code 2 → HTTP Request)` — only the check and the Code node change:

```
Trigger (webhook)
   │
   ▼
HTTP Request  POST /check-demo-booking        ← replaces the GOOGLECALENDAR_EVENTS_LIST Tool node
   │
   ▼
Code  (transform, below)
   │
   ▼
If  {{ $json.meeting_found }} is true
   ├─ True  → Code 1 (confirmation) → HTTP Request 1  POST /api/call   ← unchanged
   └─ False → Code 2 (booking)      → HTTP Request    POST /api/call   ← unchanged
```

**1. Delete the Tool node** (`GOOGLECALENDAR_EVENTS_LIST`) and its Google
connection. Nothing in SuperFlow needs Google access any more.

**2. Add an HTTP Request node** in its place:

```
POST https://<RAILWAY_DOMAIN>/check-demo-booking
Authorization: Bearer <SUPERFLOW_SHARED_SECRET>      (the same secret HTTP Request 1 / HTTP Request already use)
Content-Type:  application/json

{ "lead_email": "{{ $('Trigger').json.email }}",
  "lead_name":  "{{ $('Trigger').json.first_name }}" }
```

Set the node to **continue on error / return the response body on non-2xx**
so a `success:false` answer reaches the Code node instead of aborting silently.

**3. Replace the Code node** with:

```js
const r = $json;                       // response of the HTTP node above

if (r.success !== true || r.already_booked === null) {
  // Calendar could not be read. Never guess: stop here rather than
  // calling someone in the wrong mode.
  throw new Error(`calendar check failed: ${r.error ?? "unknown"} ${r.message ?? ""}`);
}

const ev = r.event;
return {
  ...$('Trigger').json,
  meeting_found: r.already_booked === true,
  meeting_id:    ev?.id        ?? null,
  meeting_start: ev?.start     ?? null,
  meeting_end:   ev?.end       ?? null,
  meeting_link:  ev?.meet_link ?? ev?.html_link ?? null,
  meeting_owner: ev?.owner     ?? null,
};
```

**4. If node** — condition `{{ $json.meeting_found }}` **is true**.
`meeting_found` is only ever `true` or `false` here because the Code node
throws on an indeterminate answer; the old `!= true` style is safe again for
that reason, but "is true" is still the clearer choice.

**5. Code 1 / Code 2 / both HTTP Request nodes stay exactly as they are** —
the field names above are the ones sections O and P already consume.

### `/check-demo-booking` contract

Request: `lead_email` (required; trimmed and lower-cased) and optional
`lead_name`. Matching is by attendee email only — an upcoming, non-cancelled
event within `DEMO_CHECK_WINDOW_DAYS` (90) on `demos@lyzr.ai` where the lead
has not declined. Title and name are ignored.

```jsonc
// 200 – booked
{ "success": true, "already_booked": true, "lead_email": "john@company.com",
  "calendar_id": "demos@lyzr.ai",
  "event": { "id": "…", "summary": "Lyzr Demo – Acme / John Smith",
             "start": "2026-09-24T15:30:00+05:30", "end": "2026-09-24T16:00:00+05:30",
             "html_link": "https://www.google.com/calendar/event?eid=…",
             "meet_link": "https://meet.google.com/…",
             "owner": "Priya (Lyzr AE)" } }          // first Lyzr attendee, else organizer

// 200 – not booked
{ "success": true, "already_booked": false, "lead_email": "john@company.com",
  "calendar_id": "demos@lyzr.ai", "event": null }

// 502 / 503 – calendar could not be checked (auth, API, timeout, malformed, unconfigured)
{ "success": false, "already_booked": null, "lead_email": "john@company.com",
  "event": null, "error": "calendar_check_failed", "message": "…" }

// 400 / 401 – caller's fault
{ "success": false, "already_booked": null, "error": "invalid_request" | "unauthorized", "message": "…" }
```

### Voice agent: booking through this backend

Replace the agent's Composio `GOOGLECALENDAR_FIND_FREE_SLOTS` /
`GOOGLECALENDAR_CREATE_EVENT` actions (detach both) with one custom OpenAPI
tool set whose Default Headers carry `Authorization: Bearer <SUPERFLOW_SHARED_SECRET>`:

**Find slots** — `POST https://<RAILWAY_DOMAIN>/demo-slots`
```jsonc
{ "from": "2026-09-22T00:00:00Z", "days": 7, "duration_minutes": 30, "limit": 8,   // all optional
  "timezone": "Europe/London", "lead_hours_start": 9, "lead_hours_end": 18 }      // lead's zone, optional
→ { "success": true, "timezone": "Asia/Kolkata", "lead_timezone": "Europe/London",
    "slots": [ { "start": "2026-09-22T08:00:00.000Z", "end": "2026-09-22T08:30:00.000Z",
                 "start_local": "Tue, 22 Sept 2026, 09:00 BST", "end_local": "Tue, 22 Sept 2026, 09:30 BST" }, … ] }
```
Slots respect `DEMO_HOURS_*`, `DEMO_WORKING_DAYS`, `DEMO_MIN_NOTICE_MINUTES`
and the calendar's free/busy. Pass the lead's IANA `timezone` (the Trigger's
`timezone` field) and only slots that also fall inside the lead's local
daytime (`lead_hours_start`–`lead_hours_end`, default 09–18) come back, each
with `start_local`/`end_local` for the agent to read out. An invalid zone is a
`400`, never silently ignored. If Lyzr's hours and the lead's daytime never
overlap the list is empty — with the default 10–18 IST window that is the
case for North America, so widen `DEMO_HOURS_END` if you demo US prospects.
A free/busy failure is an error (`slot_lookup_failed`), never "everything is
free".

**Book** — `POST https://<RAILWAY_DOMAIN>/book-demo`
```jsonc
{ "lead_email": "john@company.com", "lead_name": "John Smith", "company": "Acme",
  "phone": "+1…", "start": "2026-09-22T10:00:00+05:30", "duration_minutes": 30,
  "notes": "Wants an AI SDR for outbound" }
→ 201 { "success": true, "already_booked": false,
        "event": { "id": "…", "start": "…", "end": "…", "html_link": "…",
                   "meet_link": "https://meet.google.com/…" } }
→ 200 { "success": true, "already_booked": true, "event": { …existing… } }   // idempotent
→ 409 { "success": false, "error": "slot_taken" | "slot_in_past" }
→ 502 { "success": false, "error": "calendar_check_failed" | "booking_failed" }
```
The event is created on `demos@lyzr.ai` with the lead (and `DEMO_HOST_EMAILS`)
as attendees, a Google Meet link, and `sendUpdates=all` so the lead receives
the invite. Re-booking a lead who already has an upcoming demo returns that
event instead of creating a second one.

After switching the agent's tools, point the pre-dial gate at the names
Lyzr Studio generated for the tool set (`openapi-<toolset>-<operationId>`,
visible in the agent's tool list), e.g.
`LYZR_REQUIRED_AGENT_TOOLS=openapi-demobooking-findDemoSlots,openapi-demobooking-bookDemo`.
The gate matches these as substrings of the saved agent config, so the URL
paths would not work. The spec to paste into Studio is
[`docs/lyzr-booking-tool.openapi.json`](docs/lyzr-booking-tool.openapi.json);
put the bearer secret in the tool set's Default Headers, never in the spec.

### Optional server-side safety net

`ENABLE_DEMO_BOOKING_GUARD=true` makes `POST /api/call` itself run the same
check and refuse a *booked* lead with `409 conflict` (and an unreadable
calendar with `502 calendar_check_failed`). That fits a flow that must never
call booked leads; with the confirmation-call flow above it would block the
confirmation branch, so leave it **off** there.

## Q. Transcript + summary workflow

Recommended (keeps CRM/email logic in SuperFlow):

```
call ends → this service updates state
          → POST SUPERFLOW_CALLBACK_URL
          → SuperFlow fetches the transcript
          → SuperFlow LLM summarises
          → SuperFlow Gmail tool sends the summary
```

The callback payload is small by design and never carries a full transcript.
`GET /api/calls/:callId/transcript` returns `{"available": false, "reason": ...}`
unless `LYZR_TRANSCRIPT_URL_TEMPLATE` is set (see section T).

## R. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `422 calendar_tools_missing` | The prepared agent lost `GOOGLECALENDAR_FIND_FREE_SLOTS` or `GOOGLECALENDAR_CREATE_EVENT`. **No call is placed.** Check the base agent's tools. |
| `401` on `/api/call` | `Authorization: Bearer <SUPERFLOW_SHARED_SECRET>` missing or wrong. |
| `401` on `/api/twilio/status` | Signature mismatch — almost always `PUBLIC_BASE_URL` not matching the URL Twilio actually called. |
| Silence one way | Check `audio_bridge_stopped` stats: `twilioFramesIn`/`agentFramesOut` (caller→agent) and `agentFramesIn`/`twilioFramesOut` (agent→caller). |
| Agent sounds slowed or chipmunked | `agentSampleRates` in the bridge stats shows the rate actually received. The bridge reads it per frame; a mismatch here means frame metadata was wrong. |
| No agent audio at all | Look for `livekit_agent_track_subscribed`. If absent, Lyzr dispatched no agent — check `agentDispatched` in `lyzr_session_created`. |
| `droppedFrames > 0` | The room took longer than `AUDIO_PRECONNECT_BUFFER_MS` to connect; raise it. |
| Stream closes instantly | `invalid_stream_token` or `unknown_call` in logs — see section S. |
| `/ready` returns 503 | Read `checks` in the body; usually the database. |

## S. Security & compliance notes

- **Auth:** `POST /api/call` and the call-lookup endpoints require the SuperFlow
  bearer secret, compared in constant time.
- **Twilio status webhook:** validated with Twilio's signature helper. Railway
  terminates TLS upstream, so the signed URL is rebuilt from `PUBLIC_BASE_URL`
  rather than from forwarded headers an attacker could set.
- **Media Stream upgrade:** Twilio does **not** sign the WebSocket upgrade for
  Media Streams, so there is no signature to verify. Instead the service mints a
  per-call HMAC over the `callId`, delivers it in the TwiML `<Parameter>` list
  (seen only by Twilio, over TLS), and requires it on stream start. Unknown or
  unsigned streams are refused.
- **No PII in the stream URL:** lead context travels as TwiML parameters, never
  as query string, because the WSS URL appears in Twilio logs.
- **Logging:** phone numbers and emails are masked; `LYZR_API_KEY`,
  `TWILIO_AUTH_TOKEN`, both SuperFlow secrets and `Authorization` headers are
  redacted. Secrets are never stored in the database.
- **Rate limiting** on `POST /api/call`, with `trustProxy` set for Railway.
- **Consent:** intended for leads who submitted a demo/contact request. A
  suppression hook runs before dialling when `ENABLE_DNC_CHECK=true`. This is
  **not** a legal compliance engine — production use must comply with applicable
  calling, consent, recording, disclosure, timezone and DNC laws.

## T. Known external API assumptions

Verified against Lyzr's published documentation:

1. **Session start** — `POST {LYZR_VOICE_API_BASE}/sessions/start` with
   `{"agentId": "...", "userIdentity": "twilio-<callId>"}` returns
   `{ userToken, roomName, sessionId, livekitUrl, agentDispatched }`. Verified
   live. Lyzr dispatches its agent into a LiveKit room and the backend joins the
   same room as a participant.

   > The previously documented `https://voice-sip.voice.lyzr.app/session/start`
   > **no longer resolves in public DNS** and is not used anywhere in this
   > service.

2. **Participant credential** — the Lyzr-issued `userToken` is the *only*
   credential. **No `LIVEKIT_API_KEY` or `LIVEKIT_API_SECRET` is required or
   accepted**, because the backend joins as a participant rather than minting
   its own tokens.

3. **Audio format** — PCM16 mono both ways. Outbound (prospect → agent) is
   published at 24 kHz. Inbound (agent → prospect) rate is **never assumed**:
   it is read from each `AudioFrame`'s metadata, and the downstream resampler is
   rebuilt if it changes. This matters — the live agent publishes at **48 kHz**,
   not the 24 kHz the old protocol documented, so a hardcoded rate would play
   the agent's voice back at half speed.

4. **Session end** — `POST {LYZR_VOICE_API_BASE}/sessions/end` with
   `{"sessionId": "..."}` returns 204. Called on teardown, best-effort.
5. **Voice agent CRUD** — `GET/POST/DELETE {LYZR_VOICE_API_BASE}/agents` with
   `x-api-key`. Verified directly against the live API:
   - `GET /agents/{id}` returns `{"agent": {id, config, createdAt, updatedAt,
     updatedByUserId}}` — the config is **nested under an `agent` envelope**.
   - `POST /agents` expects `{"config": {...}}` and validates keys **strictly**,
     naming any it rejects. There is no root `name` field; the clone renames
     itself via `config.agent_name`.
   - `conversation_start.who` accepts exactly `"human" | "ai"`. The base agent
     is `"human"` (correct for inbound); outbound clones are set to `"ai"` so
     the prospect is greeted instead of hearing silence.
   - The calendar actions live at `config.lyzr_tools[].action_names`, alongside
     the Composio `credential_id` the tools need, which the clone preserves.
   - `DELETE /agents/{id}` returns 204 and the agent then 404s.

   Cloning copies the base agent's own config and removes only a denylist of
   server-managed and sensitive fields (`api_key`, ids, timestamps, …). Field
   *names* removed are logged; values never are. If the create endpoint ever
   rejects a key, the service strips exactly the named keys and retries **once**.

Assumptions that could **not** be verified, and how they are contained:

- **Runtime dynamic variables are not documented.** `/session/start` accepts only
  `agentId`, so per-call context is delivered by cloning the base agent
  (`CloneAgentStrategy`). `RuntimeVariableStrategy` is implemented behind the
  same `AgentContextStrategy` interface and can be switched on without reworking
  the call flow if Lyzr documents runtime injection.
- **No transcript API is published** for external voice sessions. Nothing is
  invented: the endpoint reports `available: false` unless
  `LYZR_TRANSCRIPT_URL_TEMPLATE` (containing `{sessionId}`) is configured.
- **`DELETE /agents/{id}` is not documented but does work** (verified: 204, then
  404 on re-read). Because every call creates a clone, leaving them forever
  would accumulate one dead agent per call, so cleanup is enabled: completed
  calls older than `CLONED_AGENT_RETENTION_HOURS` (default 72) have their clone
  deleted by an hourly sweep. The stored id is cleared only after the delete
  succeeds, so failures are retried on the next sweep and never affect call
  state. Set `CLONED_AGENT_RETENTION_HOURS=0` to disable.
- **Barge-in:** LiveKit handles turn-taking server-side — when the prospect
  interrupts, the agent simply stops publishing frames. The bridge therefore
  keeps its outbound Twilio buffer to single 20 ms frames so stale audio cannot
  accumulate, and exposes `clearTwilioAudio()` for an explicit flush.
- **`agentConfig.tools` in the session response is always `[]`**, including for
  the base agent that demonstrably has calendar tools. It is not populated from
  `lyzr_tools`, so the calendar gate reads the agent config instead and never
  trusts this field.

## API reference

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/health` | — | Liveness |
| `GET` | `/ready` | — | Config + database readiness |
| `POST` | `/api/call` | Bearer | Place an outbound call |
| `POST` | `/check-demo-booking` | Bearer | Has this lead an upcoming demo on `demos@lyzr.ai`? Fails closed. |
| `POST` | `/demo-slots` | Bearer | Open demo slots (free/busy on `demos@lyzr.ai`) |
| `POST` | `/book-demo` | Bearer | Create the demo event + Meet link; idempotent per lead |
| `GET` | `/api/calls/:callId` | Bearer | Sanitized call record |
| `GET` | `/api/calls/:callId/transcript` | Bearer | Transcript, or an honest "not configured" |
| `POST` | `/api/twilio/status` | Twilio signature | Status callbacks |
| `WS` | `/twilio-media` | Per-call HMAC | Audio bridge |

### Call states

`created → agent_preparing → agent_prepared → queued → initiated → ringing →
answered → stream_connecting → streaming → completed`

Terminal: `completed` · `busy` · `no_answer` · `failed` · `canceled`.
Transitions are validated: backwards moves are refused, terminal states are
final, and duplicate or late webhooks are ignored rather than corrupting state.
The stream states are reachable directly from `queued`/`initiated`/`ringing`
because Twilio opening the media stream is itself proof the prospect answered.

## Testing

```bash
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run lint        # eslint
npm run build       # tsc -p tsconfig.build.json
```
