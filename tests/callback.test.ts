import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import { SuperflowCallback, buildCallbackPayload } from "../src/callback/superflow.js";
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

describe("buildCallbackPayload", () => {
  it("contains exactly the documented fields", () => {
    expect(Object.keys(buildCallbackPayload(call)).sort()).toEqual([
      "call_id", "call_mode", "completed_at", "email", "lyzr_session_id",
      "phone", "preferred_replacement_slot", "reschedule_required", "status", "twilio_call_sid",
    ]);
  });

  it("reports the mode and status accurately", () => {
    const payload = buildCallbackPayload(call);
    expect(payload.status).toBe("completed");
    expect(payload.call_mode).toBe("booking");
    expect(payload.reschedule_required).toBe(false);
  });

  it("never includes a transcript or secret", () => {
    expect(JSON.stringify(buildCallbackPayload(call))).not.toMatch(/secret|api_key|transcript/i);
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
});
