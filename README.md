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
