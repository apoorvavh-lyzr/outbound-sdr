import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import twilio from "twilio";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { parseEnv, type Env } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import type { AgentContextStrategy, PreparedAgent } from "../src/lyzr/contextStrategy.js";
import type { CreateCallInput, TwilioCallClient } from "../src/twilio/client.js";
import { PreflightError } from "../src/utils/errors.js";
import type { Lead } from "../src/calls/types.js";

const SECRET = "superflow-shared-secret";
const AUTH_TOKEN = "twilio-auth-token";
const BASE_URL = "https://voice.example.com";

const bookingBody = {
  phone: "+919999999999",
  first_name: "Apoorva",
  last_name: "VH",
  email: "apoorva@example.com",
  company: "Acme",
  use_case: "AI agent for customer support",
  call_mode: "booking",
  timezone: "Asia/Kolkata",
  meeting_booked: false,
  meeting_id: null,
  meeting_start: null,
  meeting_end: null,
  meeting_link: null,
  meeting_owner: null,
};

const confirmationBody = {
  ...bookingBody,
  call_mode: "confirmation",
  meeting_booked: true,
  meeting_id: "evt_123",
  meeting_start: "2026-09-15T10:00:00+05:30",
  meeting_end: "2026-09-15T10:30:00+05:30",
  meeting_link: "https://meet.google.com/abc-defg-hij",
  meeting_owner: "sdr@lyzr.ai",
};

class RecordingStrategy implements AgentContextStrategy {
  readonly name = "test-strategy";
  readonly calls: Array<{ lead: Lead; callId: string }> = [];
  failure: Error | null = null;

  async prepareCallAgent(_base: string, lead: Lead, callId: string): Promise<PreparedAgent> {
    if (this.failure) throw this.failure;
    this.calls.push({ lead, callId });
    return { agentId: `agent-${callId}`, cloned: true, strategy: this.name, removedFields: [] };
  }
}

class RecordingTwilio implements TwilioCallClient {
  readonly calls: CreateCallInput[] = [];
  async createCall(input: CreateCallInput) {
    this.calls.push(input);
    return { sid: `CA${this.calls.length}`, status: "queued" };
  }
}

let app: FastifyInstance;
let db: Database;
let strategy: RecordingStrategy;
let twilioClient: RecordingTwilio;
let env: Env;

function makeEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: BASE_URL,
    LYZR_API_KEY: "lyzr-key",
    LYZR_BASE_AGENT_ID: "6aa13809b4c51e185bbca6ba",
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_AUTH_TOKEN: AUTH_TOKEN,
    TWILIO_PHONE_NUMBER: "+16263133414",
    SUPERFLOW_SHARED_SECRET: SECRET,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

beforeEach(async () => {
  strategy = new RecordingStrategy();
  twilioClient = new RecordingTwilio();
  db = createDatabase(undefined);
  env = makeEnv();

  const built = await buildApp({
    env,
    database: db,
    strategy,
    twilioClient,
    logger: pino({ level: "silent" }),
  });
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: "/api/call",
    headers: { authorization: `Bearer ${SECRET}`, ...headers },
    payload: body,
  });
}

describe("GET /health and /ready", () => {
  it("reports service health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, service: "lyzr-outbound-voice" });
    expect(res.json().commit).toBeTypeOf("string");
  });

  it("reports readiness including a real database check", async () => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ready).toBe(true);
    expect(res.json().checks.database).toBe(true);
  });

  it("is not ready when the database is down", async () => {
    vi.spyOn(db, "ping").mockRejectedValueOnce(new Error("connection refused"));
    const res = await app.inject({ method: "GET", url: "/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json().checks.database).toBe(false);
  });
});

describe("POST /api/call - booking mode", () => {
  it("queues a call and returns the documented response", async () => {
    const res = await post(bookingBody);
    expect(res.statusCode).toBe(202);

    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.status).toBe("queued");
    expect(body.twilio_call_sid).toBe("CA1");
    expect(body.call_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("prepares the Lyzr agent BEFORE dialling", async () => {
    await post(bookingBody);
    expect(strategy.calls).toHaveLength(1);
    expect(twilioClient.calls).toHaveLength(1);
    expect(strategy.calls[0]!.lead.first_name).toBe("Apoorva");
  });

  it("dials with the correct numbers and stream TwiML", async () => {
    await post(bookingBody);
    const call = twilioClient.calls[0]!;

    expect(call.to).toBe("+919999999999");
    expect(call.from).toBe("+16263133414");
    expect(call.twiml).toContain('<Stream url="wss://voice.example.com/twilio-media">');
    expect(call.statusCallbackUrl).toBe("https://voice.example.com/api/twilio/status");
  });

  it("passes the callId to the stream as a Parameter, not in the URL", async () => {
    const res = await post(bookingBody);
    const twiml = twilioClient.calls[0]!.twiml;
    expect(twiml).toContain(`<Parameter name="callId" value="${res.json().call_id}"/>`);
    expect(twiml).toContain('<Parameter name="token"');
  });
});

describe("POST /api/call - confirmation mode", () => {
  it("accepts the confirmation payload and forwards meeting context", async () => {
    const res = await post(confirmationBody);
    expect(res.statusCode).toBe(202);

    const lead = strategy.calls[0]!.lead;
    expect(lead.call_mode).toBe("confirmation");
    expect(lead.meeting_id).toBe("evt_123");
    expect(lead.meeting_start).toBe("2026-09-15T10:00:00+05:30");
  });

  it("rejects confirmation mode without meeting_booked", async () => {
    const res = await post({ ...confirmationBody, meeting_booked: false });
    expect(res.statusCode).toBe(400);
    expect(twilioClient.calls).toHaveLength(0);
  });

  it("proceeds when meeting_link and meeting_owner are absent", async () => {
    const res = await post({ ...confirmationBody, meeting_link: null, meeting_owner: null });
    expect(res.statusCode).toBe(202);
  });
});

describe("POST /api/call - validation and auth", () => {
  it("returns 400 for an invalid phone number", async () => {
    const res = await post({ ...bookingBody, phone: "919999999999" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
    expect(twilioClient.calls).toHaveLength(0);
  });

  it("returns 400 for an invalid call_mode", async () => {
    expect((await post({ ...bookingBody, call_mode: "reschedule" })).statusCode).toBe(400);
  });

  it("returns 401 without a bearer token", async () => {
    const res = await app.inject({ method: "POST", url: "/api/call", payload: bookingBody });
    expect(res.statusCode).toBe(401);
    expect(twilioClient.calls).toHaveLength(0);
  });

  it("returns 401 for a wrong bearer token", async () => {
    const res = await post(bookingBody, { authorization: "Bearer wrong-secret" });
    expect(res.statusCode).toBe(401);
    expect(strategy.calls).toHaveLength(0);
  });
});

describe("POST /api/call - failure ordering", () => {
  it("does NOT dial when the calendar tools are missing", async () => {
    strategy.failure = new PreflightError("calendar_tools_missing", "missing GOOGLECALENDAR_CREATE_EVENT");

    const res = await post(bookingBody);
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("calendar_tools_missing");
    expect(twilioClient.calls).toHaveLength(0);
  });

  it("does NOT dial when Lyzr agent creation fails", async () => {
    strategy.failure = new Error("Lyzr create failed");
    const res = await post(bookingBody);
    expect(res.statusCode).toBe(500);
    expect(twilioClient.calls).toHaveLength(0);
  });

  it("persists the failure on the call record", async () => {
    strategy.failure = new PreflightError("calendar_tools_missing", "missing tools");
    await post(bookingBody);

    const rows = await db.query<{ status: string; error_code: string }>("SELECT * FROM calls");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_code).toBe("calendar_tools_missing");
  });
});

describe("idempotency", () => {
  it("does not create a second agent or call for a repeated key", async () => {
    const first = await post(bookingBody, { "idempotency-key": "lead-42" });
    const second = await post(bookingBody, { "idempotency-key": "lead-42" });

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(200);
    expect(second.json().call_id).toBe(first.json().call_id);
    expect(second.json().idempotent_replay).toBe(true);

    expect(strategy.calls).toHaveLength(1);
    expect(twilioClient.calls).toHaveLength(1);
  });

  it("treats different keys as different calls", async () => {
    await post(bookingBody, { "idempotency-key": "lead-1" });
    await post(bookingBody, { "idempotency-key": "lead-2" });
    expect(twilioClient.calls).toHaveLength(2);
  });

  it("allows repeats when no key is supplied", async () => {
    await post(bookingBody);
    await post(bookingBody);
    expect(twilioClient.calls).toHaveLength(2);
  });

  it("survives concurrent requests with the same key", async () => {
    const [a, b] = await Promise.all([
      post(bookingBody, { "idempotency-key": "race" }),
      post(bookingBody, { "idempotency-key": "race" }),
    ]);
    expect(a.json().call_id).toBe(b.json().call_id);
    expect(twilioClient.calls).toHaveLength(1);
  });
});

describe("GET /api/calls/:callId", () => {
  it("returns sanitized call data", async () => {
    const created = await post(bookingBody);
    const callId = created.json().call_id;

    const res = await app.inject({
      method: "GET",
      url: `/api/calls/${callId}`,
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.call_id).toBe(callId);
    expect(body.status).toBe("queued");
    expect(body.lyzr_agent_id).toBe(`agent-${callId}`);
    expect(body).not.toHaveProperty("idempotency_key");
  });

  it("404s for an unknown call", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/calls/00000000-0000-0000-0000-000000000000",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/api/calls/x" });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/calls/:callId/transcript", () => {
  it("reports honestly that no provider is configured", async () => {
    const created = await post(bookingBody);
    const res = await app.inject({
      method: "GET",
      url: `/api/calls/${created.json().call_id}/transcript`,
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().available).toBe(false);
    expect(res.json().reason).toMatch(/not configured/i);
  });
});

describe("POST /api/twilio/status", () => {
  const STATUS_URL = `${BASE_URL}/api/twilio/status`;

  async function sendStatus(params: Record<string, string>, sign = true) {
    const signature = twilio.getExpectedTwilioSignature(AUTH_TOKEN, STATUS_URL, params);
    return app.inject({
      method: "POST",
      url: "/api/twilio/status",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(sign ? { "x-twilio-signature": signature } : {}),
      },
      payload: new URLSearchParams(params).toString(),
    });
  }

  it("rejects an unsigned callback", async () => {
    const res = await sendStatus({ CallSid: "CA1", CallStatus: "completed" }, false);
    expect(res.statusCode).toBe(401);
  });

  it("advances call state on a signed callback", async () => {
    await post(bookingBody);

    const ringing = await sendStatus({ CallSid: "CA1", CallStatus: "ringing" });
    expect(ringing.statusCode).toBe(204);
    let rows = await db.query<{ status: string }>("SELECT status FROM calls");
    expect(rows[0]!.status).toBe("ringing");

    await sendStatus({ CallSid: "CA1", CallStatus: "in-progress" });
    rows = await db.query<{ status: string; answered_at: string }>("SELECT * FROM calls");
    expect(rows[0]!.status).toBe("answered");
    expect((rows[0] as unknown as { answered_at: string }).answered_at).toBeTruthy();
  });

  it("records a terminal status with a completion timestamp", async () => {
    await post(bookingBody);
    await sendStatus({ CallSid: "CA1", CallStatus: "completed" });

    const rows = await db.query<{ status: string; completed_at: string }>("SELECT * FROM calls");
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.completed_at).toBeTruthy();
  });

  it("captures Twilio error details on a failed call", async () => {
    await post(bookingBody);
    await sendStatus({ CallSid: "CA1", CallStatus: "failed", ErrorCode: "13224", ErrorMessage: "Invalid number" });

    const rows = await db.query<{ status: string; error_code: string }>("SELECT * FROM calls");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_code).toBe("twilio_13224");
  });

  it("ignores an out-of-order callback rather than regressing state", async () => {
    await post(bookingBody);
    await sendStatus({ CallSid: "CA1", CallStatus: "completed" });
    await sendStatus({ CallSid: "CA1", CallStatus: "ringing" });

    const rows = await db.query<{ status: string }>("SELECT status FROM calls");
    expect(rows[0]!.status).toBe("completed");
  });

  it("acknowledges a callback for an unknown call", async () => {
    const res = await sendStatus({ CallSid: "CAunknown", CallStatus: "completed" });
    expect(res.statusCode).toBe(204);
  });
});
