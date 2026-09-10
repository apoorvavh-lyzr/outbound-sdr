import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SuperflowCallback, buildCallbackFields, buildCallbackPayload } from "../src/callback/superflow.js";
import { parseEnv, type Env } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { CallRepository } from "../src/db/repository.js";
import { leadSchema, type CallRecord } from "../src/calls/types.js";

const CALLBACK_URL = "https://superflow.example.com/hook";

function makeEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    MOCK_EXTERNAL_SERVICES: "true",
    SUPERFLOW_CALLBACK_URL: CALLBACK_URL,
    SUPERFLOW_CALLBACK_SECRET: "callback-secret",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

let db: Database;
let repo: CallRepository;
let call: CallRecord;

beforeEach(async () => {
  db = createDatabase(undefined);
  await db.migrate();
  repo = new CallRepository(db);

  const lead = leadSchema.parse({ phone: "+919999999999", email: "a@b.com", call_mode: "booking" });
  call = await repo.create(lead, null, "base");
  call = await repo.update(call.id, {
    status: "completed",
    twilio_call_sid: "CA1",
    lyzr_session_id: "sess1",
    completed_at: new Date().toISOString(),
  });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.close();
});

describe("buildCallbackFields", () => {
  it("contains exactly the documented fields", () => {
    expect(Object.keys(buildCallbackFields(call)).sort()).toEqual([
      "call_id", "call_mode", "company", "email", "first_name", "last_name",
      "lyzr_session_id", "phone", "status", "timezone", "use_case",
    ]);
  });

  it("reports the mode and status accurately", () => {
    const payload = buildCallbackFields(call);
    expect(payload.status).toBe("completed");
    expect(payload.call_mode).toBe("booking");
    expect(payload.lyzr_session_id).toBe("sess1");
  });

  it("never includes a transcript or secret", () => {
    expect(JSON.stringify(buildCallbackPayload(call))).not.toMatch(/secret|api_key|transcript/i);
    expect(JSON.stringify(buildCallbackFields(call))).not.toMatch(/secret|api_key|transcript/i);
  });
});

describe("workflow-execute shape", () => {
  it("wraps the fields for the execute API when a workflow id is set", () => {
    const payload = buildCallbackPayload(call, "wf-123") as Record<string, unknown>;
    expect(payload.workflow_id).toBe("wf-123");
    expect((payload.input as unknown[])[0]).toEqual(buildCallbackFields(call));
  });

  it("stays flat when no workflow id is set", () => {
    expect(buildCallbackPayload(call)).toEqual(buildCallbackFields(call));
  });

  it("sends x-webhook-secret, not a bearer token, for the execute API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const env = makeEnv({ SUPERFLOW_CALLBACK_WORKFLOW_ID: "wf-123" });
    await new SuperflowCallback(env, repo, pino({ level: "silent" })).send(call);

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-webhook-secret"]).toBe("callback-secret");
    expect(headers.authorization).toBeUndefined();

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.workflow_id).toBe("wf-123");
    expect(body.input[0].call_id).toBe(call.id);
  });

  it("keeps the bearer token for a plain webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call);

    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer callback-secret");
    expect(headers["x-webhook-secret"]).toBeUndefined();
  });
});

describe("SuperflowCallback", () => {
  it("is disabled without a callback URL", async () => {
    const callback = new SuperflowCallback(makeEnv({ SUPERFLOW_CALLBACK_URL: "" }), repo, pino({ level: "silent" }));
    expect(callback.enabled).toBe(false);
    expect(await callback.send(call)).toBe(false);
  });

  it("posts the payload with the bearer secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const ok = await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call);
    expect(ok).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(CALLBACK_URL);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer callback-secret");
    expect(JSON.parse(init.body).call_id).toBe(call.id);
  });

  it("retries a 5xx then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT change the call's status when delivery fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call);

    // The call really did complete; a reporting failure must not rewrite that.
    const after = await repo.findById(call.id);
    expect(after!.status).toBe("completed");
    expect(after!.error_code).toBeNull();
  });

  it("persists callback attempts for auditing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call);

    const attempts = await db.query("SELECT * FROM callback_attempts WHERE call_id = ?", [call.id]);
    expect(attempts).toHaveLength(1);
  });

  it("records a failed attempt too", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 400 })));
    await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call);

    const attempts = await db.query<{ ok: number }>("SELECT * FROM callback_attempts WHERE call_id = ?", [call.id]);
    expect(attempts).toHaveLength(1);
    expect(Boolean(attempts[0]!.ok)).toBe(false);
  });

  it("omits the authorization header when no secret is set", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new SuperflowCallback(makeEnv({ SUPERFLOW_CALLBACK_SECRET: "" }), repo, pino({ level: "silent" })).send(call);
    expect((fetchMock.mock.calls[0]![1].headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("sends only once even when Twilio repeats the completed webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const callback = new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" }));

    expect(await callback.send(call)).toBe(true);
    expect(await callback.send(call)).toBe(false);
    expect(await callback.send(call)).toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await repo.findById(call.id))!.post_call_callback_sent_at).not.toBeNull();
  });

  it("posts the internal call id, not the Twilio SID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await new SuperflowCallback(makeEnv(), repo, pino({ level: "silent" })).send(call);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.call_id).toBe(call.id);
    expect(body.call_id).not.toBe("CA1");
    expect(body.lyzr_session_id).toBe("sess1");
  });
});
