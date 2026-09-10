import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pino } from "pino";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { parseEnv, type Env } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import type { AgentContextStrategy, PreparedAgent } from "../src/lyzr/contextStrategy.js";
import type { CreateCallInput, TwilioCallClient } from "../src/twilio/client.js";
import type { Lead } from "../src/calls/types.js";

const INTAKE_URL = "https://superflow.example.com/intake";

const validLead = {
  first_name: "Apoorva",
  last_name: "VH",
  email: "vhapoorva@gmail.com",
  phone: "+919876543210",
  company: "Lyzr",
  use_case: "I want an AI SDR",
  timezone: "Asia/Kolkata",
};

/** Fails the test if anything tries to place a real call. */
class NeverDialsTwilio implements TwilioCallClient {
  readonly calls: CreateCallInput[] = [];
  async createCall(input: CreateCallInput) {
    this.calls.push(input);
    return { sid: "CA-should-not-happen", status: "queued" };
  }
}

class StubStrategy implements AgentContextStrategy {
  readonly name = "test-strategy";
  async prepareCallAgent(_base: string, _lead: Lead, callId: string): Promise<PreparedAgent> {
    return { agentId: `agent-${callId}`, cloned: false, strategy: this.name, removedFields: [] };
  }
}

let app: FastifyInstance;
let db: Database;
let twilioClient: NeverDialsTwilio;

function makeEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://voice.example.com",
    LYZR_API_KEY: "lyzr-key",
    LYZR_BASE_AGENT_ID: "6aa13809b4c51e185bbca6ba",
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_AUTH_TOKEN: "twilio-auth-token",
    TWILIO_PHONE_NUMBER: "+16263133414",
    SUPERFLOW_SHARED_SECRET: "superflow-shared-secret",
    SUPERFLOW_INTAKE_WEBHOOK_URL: INTAKE_URL,
    ...overrides,
  } as NodeJS.ProcessEnv);
}

async function build(env: Env = makeEnv()) {
  db = createDatabase(undefined);
  twilioClient = new NeverDialsTwilio();
  const built = await buildApp({
    env,
    database: db,
    strategy: new StubStrategy(),
    twilioClient,
    logger: pino({ level: "silent" }),
  });
  app = built.app;
  await app.ready();
}

function postLead(body: unknown) {
  return app.inject({ method: "POST", url: "/api/lead", payload: body as Record<string, unknown> });
}

beforeEach(async () => {
  await build();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  await db.close();
});

describe("GET /", () => {
  it("serves the demo form", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("<title>Book a Demo with Lyzr</title>");
    expect(res.body).toContain("Talk to Lyzr");
    expect(res.body).toContain("+919876543210");
  });

  it("leaks no secret into the page", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    for (const secret of [
      INTAKE_URL,
      "superflow-shared-secret",
      "twilio-auth-token",
      "lyzr-key",
      "AC1",
    ]) {
      expect(res.body).not.toContain(secret);
    }
  });
});

describe("POST /api/lead validation", () => {
  it("rejects a missing email", async () => {
    const { email: _email, ...body } = validLead;
    const res = await postLead(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fieldErrors.email).toBeTruthy();
  });

  it("rejects an invalid email", async () => {
    const res = await postLead({ ...validLead, email: "not-an-email" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fieldErrors.email[0]).toContain("valid address");
  });

  it("rejects a phone without a leading +", async () => {
    const res = await postLead({ ...validLead, phone: "919876543210" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fieldErrors.phone[0]).toContain("beginning with +");
  });

  it("rejects a missing use_case", async () => {
    const { use_case: _useCase, ...body } = validLead;
    const res = await postLead(body);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details.fieldErrors.use_case).toBeTruthy();
  });

  it("rejects a missing first_name and company", async () => {
    const res = await postLead({ ...validLead, first_name: "  ", company: "" });
    const errors = res.json().error.details.fieldErrors;
    expect(res.statusCode).toBe(400);
    expect(errors.first_name).toBeTruthy();
    expect(errors.company).toBeTruthy();
  });

  it("never forwards an invalid lead", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await postLead({ ...validLead, email: "nope" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/lead forwarding", () => {
  it("accepts a valid lead and forwards it to the intake webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postLead(validLead);

    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    expect(res.json().message).toBe("Thanks — we'll follow up shortly.");
    expect(res.json().submission_id).toMatch(/^[0-9a-f-]{36}$/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe(INTAKE_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");

    const forwarded = JSON.parse(init.body as string);
    expect(forwarded).toEqual({
      submission_id: res.json().submission_id,
      first_name: "Apoorva",
      last_name: "VH",
      email: "vhapoorva@gmail.com",
      phone: "+919876543210",
      company: "Lyzr",
      use_case: "I want an AI SDR",
      timezone: "Asia/Kolkata",
    });
  });

  it("defaults a missing timezone to Asia/Kolkata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const { timezone: _tz, ...body } = validLead;
    expect((await postLead(body)).statusCode).toBe(200);

    const forwarded = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(forwarded.timezone).toBe("Asia/Kolkata");
    expect(forwarded.last_name).toBe("VH");
  });

  it("gives each submission its own server-generated id", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const first = (await postLead(validLead)).json().submission_id;
    const second = (await postLead(validLead)).json().submission_id;
    expect(first).not.toBe(second);
  });

  it("ignores a browser-supplied submission_id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await postLead({ ...validLead, submission_id: "forged-by-client" });
    const forwarded = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(forwarded.submission_id).not.toBe("forged-by-client");
    expect(forwarded.submission_id).toBe(res.json().submission_id);
  });

  it("returns 502 when the intake webhook responds with an error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 500 })));

    const res = await postLead(validLead);
    expect(res.statusCode).toBe(502);
    expect(res.json().success).toBeUndefined();
    expect(JSON.stringify(res.json())).not.toContain(INTAKE_URL);
  });

  it("returns 502 when the intake webhook is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const res = await postLead(validLead);
    expect(res.statusCode).toBe(502);
    expect(res.json().success).toBeUndefined();
  });

  it("never places a Twilio call from the intake route", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
    await postLead(validLead);
    expect(twilioClient.calls).toHaveLength(0);
  });
});

describe("environment", () => {
  it("requires SUPERFLOW_INTAKE_WEBHOOK_URL in production", () => {
    expect(() =>
      parseEnv({
        NODE_ENV: "production",
        PUBLIC_BASE_URL: "https://voice.example.com",
        DATABASE_URL: "postgres://localhost/db",
        LYZR_API_KEY: "k",
        LYZR_BASE_AGENT_ID: "a",
        TWILIO_ACCOUNT_SID: "AC1",
        TWILIO_AUTH_TOKEN: "t",
        TWILIO_PHONE_NUMBER: "+1",
        SUPERFLOW_SHARED_SECRET: "s",
      } as NodeJS.ProcessEnv),
    ).toThrow(/SUPERFLOW_INTAKE_WEBHOOK_URL/);
  });

  it("rejects a non-absolute intake URL", () => {
    expect(() => makeEnv({ SUPERFLOW_INTAKE_WEBHOOK_URL: "superflow.example.com/intake" })).toThrow(
      /absolute http\(s\) URL/,
    );
  });
});
