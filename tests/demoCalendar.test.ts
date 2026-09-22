import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { parseEnv, type Env } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import {
  DemoBookingChecker,
  calendarsToCheck,
  GoogleServiceAccountAuth,
  eventMatchesLead,
  normalizePrivateKey,
  type FetchLike,
} from "../src/google/calendar.js";
import { computeFreeSlots, type BookingConfig } from "../src/google/booking.js";
import type { AgentContextStrategy, PreparedAgent } from "../src/lyzr/contextStrategy.js";
import type { CreateCallInput, TwilioCallClient } from "../src/twilio/client.js";
import type { Lead } from "../src/calls/types.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const ESCAPED_PEM = PEM.replace(/\n/g, "\\n");
const SECRET = "superflow-shared-secret";
const CAL = "demos@lyzr.ai";
const silent = pino({ level: "silent" });
/**
 * A Monday comfortably in the future, during British Summer Time so the
 * London expectations hold. Route tests must not pin a date that today can
 * drift past, or every slot is filtered out as being in the past.
 */
const FUTURE_MONDAY = "2027-09-20";

// ---------------------------------------------------------------------------
// Stubbed Google: token endpoint + events.list + freeBusy + events.insert
// ---------------------------------------------------------------------------
interface GoogleStub {
  events: unknown[];
  /** Events per calendar id; falls back to `events` for the demo calendar. */
  eventsByCalendar: Record<string, unknown[]>;
  busyByCalendar: Record<string, { start: string; end: string }[]>;
  freeBusyErrors: Record<string, unknown[]>;
  subjects: string[];
  freeBusyItems: string[][];
  busy: { start: string; end: string }[];
  tokenStatus: number;
  listStatus: number;
  tokenCalls: number;
  listCalls: string[];
  inserted: unknown[];
  scopes: string[];
  hang?: boolean;
}

function makeStub(overrides: Partial<GoogleStub> = {}): GoogleStub & { fetch: FetchLike } {
  const stub: GoogleStub = {
    events: [],
    eventsByCalendar: {},
    busyByCalendar: {},
    freeBusyErrors: {},
    subjects: [],
    freeBusyItems: [],
    busy: [],
    tokenStatus: 200,
    listStatus: 200,
    tokenCalls: 0,
    listCalls: [],
    inserted: [],
    scopes: [],
    ...overrides,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const fetch: FetchLike = async (url, init) => {
    if (stub.hang) {
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    if (url === "https://oauth2.googleapis.com/token") {
      stub.tokenCalls += 1;
      const assertion = String(init?.body).match(/assertion=([^&]+)/)?.[1] ?? "";
      const claims = JSON.parse(Buffer.from(decodeURIComponent(assertion).split(".")[1]!, "base64url").toString());
      stub.scopes.push(claims.scope);
      stub.subjects.push(claims.sub);
      if (stub.tokenStatus !== 200) return json(stub.tokenStatus, { error: "unauthorized_client" });
      return json(200, { access_token: "tok", expires_in: 3600 });
    }
    if (url.includes("/freeBusy")) {
      const items = (JSON.parse(String(init?.body)).items as { id: string }[]).map((i) => i.id);
      stub.freeBusyItems.push(items);
      const calendars: Record<string, unknown> = {};
      for (const id of items) {
        calendars[id] = stub.freeBusyErrors[id]
          ? { errors: stub.freeBusyErrors[id] }
          : { busy: stub.busyByCalendar[id] ?? (id === CAL ? stub.busy : []) };
      }
      return json(200, { calendars });
    }
    if (url.includes("/events?") && init?.method === undefined) {
      expect(init?.headers).toMatchObject({ authorization: "Bearer tok" });
      stub.listCalls.push(url);
      if (stub.listStatus !== 200) return json(stub.listStatus, { error: { message: "nope" } });
      const calId = decodeURIComponent(url.split("/calendars/")[1]!.split("/events")[0]!);
      const events = stub.eventsByCalendar[calId] ?? (calId === CAL ? stub.events : []);
      const page = new URL(url).searchParams.get("pageToken");
      if (!page && events.length > 1) {
        return json(200, { items: [events[0]], nextPageToken: "p2" });
      }
      return json(200, { items: page ? events.slice(1) : events });
    }
    if (url.includes("/events?conferenceDataVersion") && init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      stub.inserted.push(body);
      return json(200, { id: "evt-new", summary: body.summary, start: body.start, end: body.end, htmlLink: "https://cal/evt-new", hangoutLink: "https://meet.google.com/abc" });
    }
    throw new Error(`unexpected url ${url}`);
  };
  return Object.assign(stub, { fetch });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Lyzr Demo",
    start: { dateTime: "2026-09-24T15:30:00Z" },
    end: { dateTime: "2026-09-24T16:00:00Z" },
    attendees: [{ email: "host@lyzr.ai", responseStatus: "accepted" }, { email: "John@Company.com", responseStatus: "needsAction" }],
    ...overrides,
  };
}

function makeChecker(stub: ReturnType<typeof makeStub>, timeoutMs = 5000) {
  const auth = new GoogleServiceAccountAuth(
    { serviceAccountEmail: "sa@proj.iam.gserviceaccount.com", privateKey: ESCAPED_PEM, privateKeyId: "kid1", impersonatedUser: CAL },
    stub.fetch,
  );
  return new DemoBookingChecker(auth, { calendarId: CAL, windowDays: 90, timeoutMs }, silent, stub.fetch);
}

// ---------------------------------------------------------------------------
describe("eventMatchesLead", () => {
  it("matches attendee email case-insensitively", () => {
    expect(eventMatchesLead(event(), "john@company.com")).toBe(true);
  });
  it("ignores cancelled events", () => {
    expect(eventMatchesLead(event({ status: "cancelled" }), "john@company.com")).toBe(false);
  });
  it("ignores declined attendees", () => {
    const e = event({ attendees: [{ email: "john@company.com", responseStatus: "declined" }] });
    expect(eventMatchesLead(e, "john@company.com")).toBe(false);
  });
  it("does not match on title, organizer or missing attendees", () => {
    expect(eventMatchesLead(event({ summary: "john@company.com", attendees: undefined }), "john@company.com")).toBe(false);
    expect(eventMatchesLead(event({ organizer: { email: "john@company.com" }, attendees: [] }), "john@company.com")).toBe(false);
  });
});

describe("normalizePrivateKey", () => {
  it("unescapes \\n sequences", () => {
    expect(normalizePrivateKey(ESCAPED_PEM)).toBe(PEM);
  });
});

describe("DemoBookingChecker", () => {
  it("finds a booking and reports the earliest match", async () => {
    const stub = makeStub({ events: [event({ id: "other", attendees: [{ email: "x@y.com" }] }), event()] });
    const res = await makeChecker(stub).check("  JOHN@company.com ");
    expect(res.alreadyBooked).toBe(true);
    expect(res.event).toMatchObject({ id: "evt-1", start: "2026-09-24T15:30:00Z", end: "2026-09-24T16:00:00Z" });
    expect(stub.listCalls).toHaveLength(2); // followed nextPageToken
    expect(stub.scopes).toEqual(["https://www.googleapis.com/auth/calendar"]);
  });

  it("queries a 90-day window with singleEvents and the lead email as prefilter", async () => {
    const stub = makeStub();
    await makeChecker(stub).check("john@company.com");
    const params = new URL(stub.listCalls[0]!).searchParams;
    expect(params.get("singleEvents")).toBe("true");
    expect(params.get("q")).toBe("john@company.com");
    const span = Date.parse(params.get("timeMax")!) - Date.parse(params.get("timeMin")!);
    expect(span).toBe(90 * 24 * 3600 * 1000);
  });

  it("reuses the cached token across checks", async () => {
    const stub = makeStub();
    const c = makeChecker(stub);
    await c.check("a@b.com");
    await c.check("c@d.com");
    expect(stub.tokenCalls).toBe(1);
  });

  it("throws calendar_check_failed on token, API, and timeout failures", async () => {
    await expect(makeChecker(makeStub({ tokenStatus: 401 })).check("a@b.com")).rejects.toMatchObject({ code: "calendar_check_failed", statusCode: 502 });
    await expect(makeChecker(makeStub({ listStatus: 403 })).check("a@b.com")).rejects.toMatchObject({ code: "calendar_check_failed" });
    await expect(makeChecker(makeStub({ hang: true }), 50).check("a@b.com")).rejects.toMatchObject({ code: "calendar_check_failed", message: expect.stringContaining("timed out") });
  });
});

describe("computeFreeSlots", () => {
  const cfg: BookingConfig = {
    calendarId: CAL,
    timezone: "Asia/Kolkata",
    hoursStart: 10,
    hoursEnd: 12,
    workingDays: [1, 2, 3, 4, 5],
    slotMinutes: 30,
    minNoticeMinutes: 0,
    timeoutMs: 1000,
  };
  // 2026-09-21 is a Monday. 10:00 IST = 04:30Z.
  const from = new Date("2026-09-21T00:00:00Z");

  it("walks business hours in the configured zone and skips busy intervals", () => {
    const busy = [{ start: Date.parse("2026-09-21T05:00:00Z"), end: Date.parse("2026-09-21T05:30:00Z") }];
    const slots = computeFreeSlots(cfg, busy, from, 1, 30, from, 10);
    // 10:00–12:00 IST = 04:30–06:30Z; the 05:00 slot is busy, 06:30 would end past close.
    expect(slots.map((s) => s.start)).toEqual(["2026-09-21T04:30:00.000Z", "2026-09-21T05:30:00.000Z", "2026-09-21T06:00:00.000Z"]);
  });

  it("skips weekends and respects the limit", () => {
    const sat = new Date("2026-09-26T00:00:00Z");
    const slots = computeFreeSlots(cfg, [], sat, 3, 30, sat, 2);
    expect(slots).toHaveLength(2);
    expect(slots[0]!.start).toBe("2026-09-28T04:30:00.000Z"); // Monday
  });
});

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------
class NeverDialsTwilio implements TwilioCallClient {
  readonly calls: CreateCallInput[] = [];
  async createCall(input: CreateCallInput) {
    this.calls.push(input);
    return { sid: "CA-should-not-happen", status: "queued" };
  }
}
class StubStrategy implements AgentContextStrategy {
  readonly name = "test-strategy";
  async prepareCallAgent(_b: string, _l: Lead, callId: string): Promise<PreparedAgent> {
    return { agentId: `agent-${callId}`, cloned: false, strategy: this.name, removedFields: [] };
  }
}

function makeEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://voice.example.com",
    LYZR_API_KEY: "lyzr-key",
    LYZR_BASE_AGENT_ID: "6aa13809b4c51e185bbca6ba",
    TWILIO_ACCOUNT_SID: "AC1",
    TWILIO_AUTH_TOKEN: "twilio-auth-token",
    TWILIO_PHONE_NUMBER: "+16263133414",
    SUPERFLOW_SHARED_SECRET: SECRET,
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@proj.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: ESCAPED_PEM,
    GOOGLE_PRIVATE_KEY_ID: "kid1",
    DEMO_MIN_NOTICE_MINUTES: "0",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

let app: FastifyInstance;
let db: Database;
let twilio: NeverDialsTwilio;

async function build(stub: ReturnType<typeof makeStub>, env: Env = makeEnv()) {
  db = createDatabase(undefined);
  twilio = new NeverDialsTwilio();
  const built = await buildApp({
    env,
    database: db,
    strategy: new StubStrategy(),
    twilioClient: twilio,
    logger: silent,
    demoChecker: makeChecker(stub),
  });
  app = built.app;
  await app.ready();
}

const auth = { authorization: `Bearer ${SECRET}` };
const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
  app.inject({ method: "POST", url, payload: payload as Record<string, unknown>, headers });

afterEach(async () => {
  await app?.close();
  await db?.close();
});

describe("POST /check-demo-booking", () => {
  it("returns already_booked:true with the event", async () => {
    await build(makeStub({ events: [event()] }));
    const res = await post("/check-demo-booking", { lead_email: " John@Company.com ", lead_name: "John" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, already_booked: true, lead_email: "john@company.com", event: { id: "evt-1", summary: "Lyzr Demo" } });
  });

  it("returns already_booked:false with event:null", async () => {
    await build(makeStub());
    const res = await post("/check-demo-booking", { lead_email: "john@company.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(expect.objectContaining({ success: true, already_booked: false, event: null }));
  });

  it("fails closed with already_booked:null when Google fails", async () => {
    await build(makeStub({ listStatus: 500 }));
    const res = await post("/check-demo-booking", { lead_email: "john@company.com" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, already_booked: null, error: "calendar_check_failed" });
    expect(JSON.stringify(res.json())).not.toContain("PRIVATE KEY");
  });

  it("rejects missing email and bad auth in the same envelope", async () => {
    await build(makeStub());
    expect((await post("/check-demo-booking", {})).statusCode).toBe(400);
    expect((await post("/check-demo-booking", { lead_email: "nope" })).json()).toMatchObject({ success: false, already_booked: null, error: "invalid_request" });
    const unauth = await post("/check-demo-booking", { lead_email: "a@b.com" }, {});
    expect(unauth.statusCode).toBe(401);
    expect(unauth.json()).toMatchObject({ success: false, already_booked: null, error: "unauthorized" });
  });

  it("answers 503 when Google is not configured", async () => {
    db = createDatabase(undefined);
    const built = await buildApp({
      env: makeEnv({ GOOGLE_SERVICE_ACCOUNT_EMAIL: "", GOOGLE_PRIVATE_KEY: "" }),
      database: db, strategy: new StubStrategy(), twilioClient: new NeverDialsTwilio(), logger: silent,
    });
    app = built.app;
    const res = await post("/check-demo-booking", { lead_email: "a@b.com" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ success: false, already_booked: null, error: "calendar_check_failed" });
  });
});

describe("POST /api/call with ENABLE_DEMO_BOOKING_GUARD", () => {
  const lead = { first_name: "John", last_name: "S", email: "john@company.com", phone: "+919876543210", company: "Co", call_mode: "booking" };

  it("refuses to dial a booked lead", async () => {
    await build(makeStub({ events: [event()] }), makeEnv({ ENABLE_DEMO_BOOKING_GUARD: "true" }));
    const res = await post("/api/call", lead);
    expect(res.statusCode).toBe(409);
    expect(twilio.calls).toHaveLength(0);
  });

  it("refuses to dial when the calendar cannot be checked", async () => {
    await build(makeStub({ tokenStatus: 500 }), makeEnv({ ENABLE_DEMO_BOOKING_GUARD: "true" }));
    const res = await post("/api/call", lead);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("calendar_check_failed");
    expect(twilio.calls).toHaveLength(0);
  });

  it("dials when no booking exists", async () => {
    await build(makeStub(), makeEnv({ ENABLE_DEMO_BOOKING_GUARD: "true" }));
    const res = await post("/api/call", lead);
    expect(res.statusCode).toBe(202);
    expect(twilio.calls).toHaveLength(1);
  });

  it("does not consult the calendar when the guard is off", async () => {
    const stub = makeStub({ events: [event()] });
    await build(stub);
    expect((await post("/api/call", lead)).statusCode).toBe(202);
    expect(stub.listCalls).toHaveLength(0);
  });
});

describe("POST /demo-slots and /book-demo", () => {
  it("lists open slots using the calendar scope", async () => {
    const stub = makeStub();
    await build(stub);
    const res = await post("/demo-slots", { from: `${FUTURE_MONDAY}T00:00:00Z`, days: 1, limit: 3 });
    expect(res.statusCode).toBe(200);
    expect(res.json().slots).toHaveLength(3);
    expect(res.json().timezone).toBe("Asia/Kolkata");
    expect(stub.scopes).toContain("https://www.googleapis.com/auth/calendar");
  });

  it("books a demo with the lead as attendee and a Meet link", async () => {
    const stub = makeStub();
    await build(stub);
    const res = await post("/book-demo", {
      lead_email: "John@Company.com", lead_name: "John Smith", company: "Co",
      start: "2099-09-24T10:00:00+05:30", notes: "AI SDR",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, already_booked: false, event: { id: "evt-new", meet_link: "https://meet.google.com/abc" } });
    const body = stub.inserted[0] as Record<string, unknown>;
    expect(body.attendees).toEqual([{ email: "john@company.com", displayName: "John Smith" }]);
    expect(body.start).toEqual({ dateTime: "2099-09-24T04:30:00.000Z", timeZone: "UTC" });
    expect(body.description).toContain("AI SDR");
  });

  it("is idempotent for an already-booked lead", async () => {
    const stub = makeStub({ events: [event()] });
    await build(stub);
    const res = await post("/book-demo", { lead_email: "john@company.com", start: "2099-09-24T10:00:00Z" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, already_booked: true, event: { id: "evt-1" } });
    expect(stub.inserted).toHaveLength(0);
  });

  it("refuses a busy slot and a past slot", async () => {
    const stub = makeStub({ busy: [{ start: "2099-09-24T10:00:00Z", end: "2099-09-24T10:30:00Z" }] });
    await build(stub);
    const busy = await post("/book-demo", { lead_email: "a@b.com", start: "2099-09-24T10:15:00Z" });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe("slot_taken");
    const past = await post("/book-demo", { lead_email: "a@b.com", start: "2020-01-01T10:00:00Z" });
    expect(past.json().error).toBe("slot_in_past");
    expect(stub.inserted).toHaveLength(0);
  });

  it("never books when the pre-check itself fails", async () => {
    const stub = makeStub({ listStatus: 500 });
    await build(stub);
    const res = await post("/book-demo", { lead_email: "a@b.com", start: "2099-09-24T10:00:00Z" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("calendar_check_failed");
    expect(stub.inserted).toHaveLength(0);
  });
});

describe("missingCalendarActions with backend booking tools", async () => {
  const { missingCalendarActions } = await import("../src/lyzr/client.js");
  it("accepts an agent whose HTTP tools point at this backend", () => {
    const config = { tools: [{ type: "http", url: "https://voice.example.com/demo-slots" }, { type: "http", url: "https://voice.example.com/book-demo" }] };
    expect(missingCalendarActions(config, ["/demo-slots", "/book-demo"])).toEqual([]);
    expect(missingCalendarActions(config, ["/demo-slots", "/book-demo", "GOOGLECALENDAR_CREATE_EVENT"])).toEqual(["GOOGLECALENDAR_CREATE_EVENT"]);
    expect(missingCalendarActions(config, [])).toEqual([]);
  });
});

describe("lead-timezone slot filtering", () => {
  const cfg: BookingConfig = {
    calendarId: CAL, timezone: "Asia/Kolkata", hoursStart: 10, hoursEnd: 18,
    workingDays: [1, 2, 3, 4, 5], slotMinutes: 30, minNoticeMinutes: 0, timeoutMs: 1000,
  };
  // Monday 2026-09-21. IST 10:00–18:00 = 04:30Z–12:30Z. New York (EDT, -4) 09:00 = 13:00Z.
  const from = new Date("2026-09-21T00:00:00Z");

  it("returns nothing when Lyzr hours and the lead's daytime never overlap", () => {
    const slots = computeFreeSlots(cfg, [], from, 1, 30, from, 50, { timezone: "America/New_York", hoursStart: 9, hoursEnd: 18 });
    expect(slots).toEqual([]);
  });

  it("keeps only the overlap and renders local times", () => {
    // Lead in London (BST, +1): 09:00 London = 08:00Z. Overlap with IST window: 08:00Z–12:30Z.
    const slots = computeFreeSlots(cfg, [], from, 1, 30, from, 50, { timezone: "Europe/London", hoursStart: 9, hoursEnd: 18 });
    expect(slots[0]!.start).toBe("2026-09-21T08:00:00.000Z");
    expect(slots.at(-1)!.end).toBe("2026-09-21T12:30:00.000Z");
    expect(slots[0]!.start_local).toMatch(/Mon,? 21 Sep(t)? 2026,? 09:00/);
  });

  it("allows a slot ending exactly at the lead's closing hour", () => {
    // Lead in Dubai (+4): hours 9–12 → 05:00Z–08:00Z. Slot 07:30Z–08:00Z ends exactly at 12:00 Dubai.
    const slots = computeFreeSlots(cfg, [], from, 1, 30, from, 50, { timezone: "Asia/Dubai", hoursStart: 9, hoursEnd: 12 });
    expect(slots.at(-1)!.end).toBe("2026-09-21T08:00:00.000Z");
  });

  it("route validates the timezone and filters", async () => {
    await build(makeStub());
    const bad = await post("/demo-slots", { timezone: "Mars/Olympus" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain("IANA");

    const ok = await post("/demo-slots", { from: `${FUTURE_MONDAY}T00:00:00Z`, days: 1, limit: 50, timezone: "Europe/London" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().lead_timezone).toBe("Europe/London");
    expect(ok.json().slots[0]).toMatchObject({ start: `${FUTURE_MONDAY}T08:00:00.000Z` });
    expect(ok.json().slots[0].start_local).toBeTruthy();
  });
});

describe("empty JSON bodies from tool callers", () => {
  it("treats an empty application/json body as {} on /demo-slots", async () => {
    await build(makeStub());
    const res = await app.inject({ method: "POST", url: "/demo-slots", headers: { ...auth, "content-type": "application/json" }, payload: "" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().slots)).toBe(true);
  });

  it("still rejects malformed JSON with 400", async () => {
    await build(makeStub());
    const res = await app.inject({ method: "POST", url: "/demo-slots", headers: { ...auth, "content-type": "application/json" }, payload: "{not json" });
    expect(res.statusCode).toBe(400);
  });

  it("still requires lead_email on /book-demo with an empty body", async () => {
    await build(makeStub());
    const res = await app.inject({ method: "POST", url: "/book-demo", headers: { ...auth, "content-type": "application/json" }, payload: "" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

describe("bookDemo accepts generic calendar field names", () => {
  it("maps start_time / invitees / end_time onto the schema", async () => {
    const stub = makeStub();
    await build(stub);
    const res = await post("/book-demo", {
      calendar_id: "demos@lyzr.ai", title: "Lyzr Demo - Lyzr", invitees: ["apoorva.vh@lyzr.ai"],
      start_time: "2099-09-22T16:30:00+05:30", end_time: "2099-09-22T17:00:00+05:30", timezone: "Asia/Kolkata",
    });
    expect(res.statusCode).toBe(201);
    const body = stub.inserted[0] as Record<string, unknown>;
    expect(body.attendees).toEqual([{ email: "apoorva.vh@lyzr.ai", displayName: undefined }]);
    expect(body.start).toEqual({ dateTime: "2099-09-22T11:00:00.000Z", timeZone: "UTC" });
    expect(body.end).toEqual({ dateTime: "2099-09-22T11:30:00.000Z", timeZone: "UTC" });
  });

  it("names the missing field", async () => {
    await build(makeStub());
    const res = await post("/book-demo", { title: "x", start_time: "2099-09-22T16:30:00+05:30" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/^lead_email is required/);
  });
});

describe("bookDemo accepts the singular Composio-style names", () => {
  it("maps invite / duration onto the schema", async () => {
    const stub = makeStub();
    await build(stub);
    const res = await post("/book-demo", {
      title: "Lyzr Demo - Lyzr", invite: "apoorva.vh@lyzr.ai", start: "2099-09-21T14:30:00+05:30", duration: 30, timezone: "Asia/Kolkata",
    });
    expect(res.statusCode).toBe(201);
    const body = stub.inserted[0] as Record<string, unknown>;
    expect(body.attendees).toEqual([{ email: "apoorva.vh@lyzr.ai", displayName: undefined }]);
    expect(body.end).toEqual({ dateTime: "2099-09-21T09:30:00.000Z", timeZone: "UTC" });
  });
});

// ---------------------------------------------------------------------------
// Assigned AE: their calendar is consulted alongside the shared one
// ---------------------------------------------------------------------------
const AE = "bhavana.bolgam@lyzr.ai";

describe("calendarsToCheck", () => {
  it("adds the AE and de-duplicates the demo mailbox", () => {
    expect(calendarsToCheck(CAL, AE)).toEqual([CAL, AE]);
    expect(calendarsToCheck(CAL, undefined)).toEqual([CAL]);
    expect(calendarsToCheck(CAL, "  DEMOS@LYZR.AI ")).toEqual([CAL]);
  });
});

describe("POST /check-demo-booking with ae_email", () => {
  it("finds a booking that exists only on the AE's calendar", async () => {
    const stub = makeStub({ eventsByCalendar: { [CAL]: [], [AE]: [event({ id: "ae-evt" })] } });
    await build(stub);
    const res = await post("/check-demo-booking", { lead_email: "john@company.com", ae_email: AE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      already_booked: true, ae_email: AE,
      calendars_checked: [CAL, AE],
      event: { id: "ae-evt", calendar_id: AE },
    });
    // Each calendar is read as its own owner.
    expect(stub.subjects).toEqual([CAL, AE]);
  });

  it("checks only the shared calendar when no AE is assigned", async () => {
    const stub = makeStub();
    await build(stub);
    const res = await post("/check-demo-booking", { lead_email: "john@company.com", ae_email: null });
    expect(res.json().calendars_checked).toEqual([CAL]);
    expect(stub.subjects).toEqual([CAL]);
  });

  it("fails closed when the AE's calendar cannot be read", async () => {
    const stub = makeStub({ listStatus: 403 });
    await build(stub);
    const res = await post("/check-demo-booking", { lead_email: "john@company.com", ae_email: AE });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ success: false, already_booked: null, error: "calendar_check_failed" });
  });

  it("refuses an AE outside the impersonation domain", async () => {
    await build(makeStub());
    const res = await post("/check-demo-booking", { lead_email: "john@company.com", ae_email: "someone@evil.com" });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain("@lyzr.ai");
  });
});

describe("/demo-slots and /book-demo with ae_email", () => {
  it("treats the AE's busy time as unavailable", async () => {
    const stub = makeStub({
      busyByCalendar: { [CAL]: [], [AE]: [{ start: `${FUTURE_MONDAY}T04:30:00Z`, end: `${FUTURE_MONDAY}T06:00:00Z` }] },
    });
    await build(stub);
    const res = await post("/demo-slots", { from: `${FUTURE_MONDAY}T00:00:00Z`, days: 1, limit: 3, ae_email: AE });
    expect(res.statusCode).toBe(200);
    expect(res.json().ae_email).toBe(AE);
    expect(stub.freeBusyItems[0]).toEqual([CAL, AE]);
    // The 04:30 and 05:30 slots are gone; the first free one starts at 06:00Z.
    expect(res.json().slots[0].start).toBe(`${FUTURE_MONDAY}T06:00:00.000Z`);
  });

  it("invites the AE and records them on the event", async () => {
    const stub = makeStub();
    await build(stub);
    const res = await post("/book-demo", {
      lead_email: "john@company.com", lead_name: "John Smith",
      start: "2099-09-24T10:00:00Z", ae_email: AE, ae_name: "Bhavana Bolgam",
    });
    expect(res.statusCode).toBe(201);
    const body = stub.inserted[0] as Record<string, unknown>;
    expect(body.attendees).toEqual([
      { email: "john@company.com", displayName: "John Smith" },
      { email: AE, displayName: "Bhavana Bolgam" },
    ]);
    expect((body.extendedProperties as { private: Record<string, string> }).private.lyzr_ae_email).toBe(AE);
  });

  it("does not double-book a lead already on the AE's calendar", async () => {
    const stub = makeStub({ eventsByCalendar: { [CAL]: [], [AE]: [event({ id: "ae-evt" })] } });
    await build(stub);
    const res = await post("/book-demo", { lead_email: "john@company.com", start: "2099-09-24T10:00:00Z", ae_email: AE });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ already_booked: true, event: { id: "ae-evt", calendar_id: AE } });
    expect(stub.inserted).toHaveLength(0);
  });

  it("never offers slots when the AE's availability is unreadable", async () => {
    const stub = makeStub({ freeBusyErrors: { [AE]: [{ domain: "global", reason: "notFound" }] } });
    await build(stub);
    const res = await post("/demo-slots", { days: 1, ae_email: AE });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("slot_lookup_failed");
  });

  it("refuses an AE outside the impersonation domain", async () => {
    await build(makeStub());
    expect((await post("/demo-slots", { ae_email: "x@evil.com" })).statusCode).toBe(400);
    expect((await post("/book-demo", { lead_email: "a@b.com", start: "2099-09-24T10:00:00Z", ae_email: "x@evil.com" })).statusCode).toBe(400);
  });
});

describe("aeNameFromEmail", () => {
  it("derives a display name only as a fallback", async () => {
    const { aeNameFromEmail } = await import("../src/lyzr/contextStrategy.js");
    expect(aeNameFromEmail("bhavana.bolgam@lyzr.ai")).toBe("Bhavana Bolgam");
    expect(aeNameFromEmail("priya@lyzr.ai")).toBe("Priya");
    expect(aeNameFromEmail(null)).toBe("");
  });
});
