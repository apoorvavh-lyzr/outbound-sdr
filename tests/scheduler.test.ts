import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { pino } from "pino";
import { CallScheduler } from "../src/calls/scheduler.js";
import { CallService } from "../src/calls/service.js";
import { parseEnv, type Env } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/db/client.js";
import { CallRepository } from "../src/db/repository.js";
import { DemoBookingChecker, GoogleServiceAccountAuth, type FetchLike } from "../src/google/calendar.js";
import type { AgentContextStrategy, PreparedAgent } from "../src/lyzr/contextStrategy.js";
import type { CreateCallInput, TwilioCallClient } from "../src/twilio/client.js";
import type { Lead } from "../src/calls/types.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/\n/g, "\\n");
const CAL = "demos@lyzr.ai";
const AE = "bhavana.bolgam@lyzr.ai";
const LEAD = "john@company.com";
const silent = pino({ level: "silent" });

class RecordingTwilio implements TwilioCallClient {
  readonly calls: CreateCallInput[] = [];
  async createCall(input: CreateCallInput) {
    this.calls.push(input);
    return { sid: `CA${this.calls.length}`, status: "queued" };
  }
}
class StubStrategy implements AgentContextStrategy {
  readonly name = "stub";
  async prepareCallAgent(_b: string, _l: Lead, callId: string): Promise<PreparedAgent> {
    return { agentId: `agent-${callId}`, cloned: false, strategy: this.name, removedFields: [] };
  }
}

function makeEnv(overrides: Record<string, string> = {}): Env {
  return parseEnv({
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://voice.example.com",
    LYZR_API_KEY: "k", LYZR_BASE_AGENT_ID: "6aa13809b4c51e185bbca6ba",
    TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_PHONE_NUMBER: "+16263133414",
    SUPERFLOW_SHARED_SECRET: "s",
    GOOGLE_SERVICE_ACCOUNT_EMAIL: "sa@p.iam.gserviceaccount.com",
    GOOGLE_PRIVATE_KEY: PEM,
    ENABLE_CALL_SCHEDULER: "true",
    REMINDER_LEAD_MINUTES: "45",
    REMINDER_GRACE_MINUTES: "15",
    MIN_HOURS_BETWEEN_CALLS: "0",
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/** now + minutes, as an ISO string. */
const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

function demoEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Lyzr Demo – Acme / John",
    start: { dateTime: at(30) },
    end: { dateTime: at(60) },
    hangoutLink: "https://meet.google.com/abc",
    organizer: { email: CAL },
    attendees: [
      { email: CAL, responseStatus: "accepted" },
      { email: AE, displayName: "Bhavana Bolgam", responseStatus: "accepted" },
      { email: LEAD, displayName: "John Smith", responseStatus: "accepted" },
    ],
    ...overrides,
  };
}

let db: Database;
let twilio: RecordingTwilio;

async function harness(events: unknown[], env: Env = makeEnv()) {
  db = createDatabase(undefined);
  await db.migrate();
  const repository = new CallRepository(db);
  twilio = new RecordingTwilio();

  const fetchImpl: FetchLike = async (url) => {
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
    if (url.includes("/events?")) return json({ items: events });
    throw new Error(`unexpected ${url}`);
  };

  const auth = new GoogleServiceAccountAuth(
    { serviceAccountEmail: "sa@p.iam.gserviceaccount.com", privateKey: PEM, impersonatedUser: CAL },
    fetchImpl,
  );
  const checker = new DemoBookingChecker(auth, { calendarId: CAL, windowDays: 90, timeoutMs: 5000 }, silent, fetchImpl);
  const service = new CallService({ env, repository, strategy: new StubStrategy(), twilio, logger: silent });
  const scheduler = new CallScheduler({ env, repository, service, checker, logger: silent });
  return { scheduler, repository, service, env };
}

let seedCount = 0;

/** The scheduler only calls prospects we already have a phone number for. */
async function seedPriorCall(repository: CallRepository, overrides: Partial<Lead> = {}) {
  seedCount += 1;
  const lead = {
    phone: "+919876543210", email: LEAD, first_name: "John", last_name: "Smith",
    company: "Acme", use_case: "AI SDR", timezone: "Asia/Kolkata",
    call_mode: "booking", meeting_booked: false,
    meeting_id: null, meeting_start: null, meeting_end: null, meeting_link: null, meeting_owner: null,
    ae_email: AE, ae_name: "Bhavana Bolgam", ...overrides,
  } as unknown as Lead;
  return repository.create(lead, `seed-key-${seedCount}`, null);
}

afterEach(async () => {
  await db?.close();
});

describe("reminder calls", () => {
  it("calls the prospect when the demo is inside the lead time", async () => {
    const { scheduler, repository } = await harness([demoEvent()]);
    await seedPriorCall(repository);

    const result = await scheduler.sweep();
    expect(result).toMatchObject({ eventsScanned: 1, remindersPlaced: 1 });
    expect(twilio.calls).toHaveLength(1);

    const placed = await repository.findByMeetingAndMode("evt-1", "reminder");
    expect(placed[0]).toMatchObject({
      call_mode: "reminder", email: LEAD, phone: "+919876543210",
      meeting_booked: true, meeting_id: "evt-1", ae_email: AE,
    });
    expect(placed[0]!.meeting_link).toBe("https://meet.google.com/abc");
  });

  it("does not call too early or after the demo has all but started", async () => {
    const early = await harness([demoEvent({ start: { dateTime: at(180) } })]);
    await seedPriorCall(early.repository);
    expect((await early.scheduler.sweep()).remindersPlaced).toBe(0);
    await db.close();

    const late = await harness([demoEvent({ start: { dateTime: at(5) } })]);
    await seedPriorCall(late.repository);
    expect((await late.scheduler.sweep()).remindersPlaced).toBe(0);
  });

  it("reminds only once per meeting, however often it sweeps", async () => {
    const { scheduler, repository } = await harness([demoEvent()]);
    await seedPriorCall(repository);
    await scheduler.sweep();
    await scheduler.sweep();
    await scheduler.sweep();
    expect(twilio.calls).toHaveLength(1);
  });

  it("skips a prospect we have no phone number for", async () => {
    const { scheduler } = await harness([demoEvent()]);
    const result = await scheduler.sweep();
    expect(result.remindersPlaced).toBe(0);
    expect(twilio.calls).toHaveLength(0);
  });

  it("ignores cancelled events and internal-only meetings", async () => {
    const internal = demoEvent({
      id: "evt-internal",
      attendees: [{ email: CAL }, { email: AE }],
    });
    const { scheduler, repository } = await harness([demoEvent({ id: "evt-cancelled", status: "cancelled" }), internal]);
    await seedPriorCall(repository);
    const result = await scheduler.sweep();
    expect(result.eventsScanned).toBe(0);
    expect(twilio.calls).toHaveLength(0);
  });
});

describe("declined invitations", () => {
  const declined = () =>
    demoEvent({
      id: "evt-declined",
      start: { dateTime: at(2000) }, // far away: this is not a reminder
      attendees: [
        { email: CAL, responseStatus: "accepted" },
        { email: AE, responseStatus: "accepted" },
        { email: LEAD, responseStatus: "declined" },
      ],
    });

  it("calls the prospect back to reschedule", async () => {
    const { scheduler, repository } = await harness([declined()]);
    await seedPriorCall(repository);

    const result = await scheduler.sweep();
    expect(result.rescheduleCallsPlaced).toBe(1);
    const placed = await repository.findByMeetingAndMode("evt-declined", "reschedule");
    expect(placed[0]).toMatchObject({ call_mode: "reschedule", email: LEAD, meeting_id: "evt-declined" });
  });

  it("stays quiet when decline calls are disabled", async () => {
    const { scheduler, repository } = await harness([declined()], makeEnv({ ENABLE_DECLINE_CALLS: "false" }));
    await seedPriorCall(repository);
    expect((await scheduler.sweep()).rescheduleCallsPlaced).toBe(0);
    expect(twilio.calls).toHaveLength(0);
  });

  it("does nothing at all when the scheduler is disabled", async () => {
    const { scheduler, repository } = await harness([demoEvent()], makeEnv({ ENABLE_CALL_SCHEDULER: "false" }));
    await seedPriorCall(repository);
    expect(await scheduler.sweep()).toMatchObject({ eventsScanned: 0, remindersPlaced: 0 });
    expect(twilio.calls).toHaveLength(0);
  });
});

describe("contact-frequency cap", () => {
  it("refuses a call once the lead has had the maximum", async () => {
    const { service, repository, env } = await harness([], makeEnv({ MAX_CALLS_PER_LEAD: "2" }));
    await seedPriorCall(repository, {});
    await seedPriorCall(repository, {});
    expect(env.MAX_CALLS_PER_LEAD).toBe(2);

    const lead = {
      phone: "+919876543210", email: LEAD, first_name: "John", last_name: "", company: "", use_case: "",
      timezone: "Asia/Kolkata", call_mode: "booking", meeting_booked: false,
      meeting_id: null, meeting_start: null, meeting_end: null, meeting_link: null, meeting_owner: null,
      ae_email: null, ae_name: null,
    } as unknown as Lead;

    await expect(service.placeCall(lead, null)).rejects.toMatchObject({ code: "conflict" });
    expect(twilio.calls).toHaveLength(0);
  });

  it("enforces a minimum gap for automated follow-ups only", async () => {
    const { service, repository } = await harness([], makeEnv({ MAX_CALLS_PER_LEAD: "9", MIN_HOURS_BETWEEN_CALLS: "4" }));
    await seedPriorCall(repository);

    const base = {
      phone: "+919876543210", email: LEAD, first_name: "John", last_name: "", company: "", use_case: "",
      timezone: "Asia/Kolkata", meeting_booked: true, meeting_id: "evt-1",
      meeting_start: at(60), meeting_end: at(90), meeting_link: null, meeting_owner: null,
      ae_email: null, ae_name: null,
    };

    await expect(service.placeCall({ ...base, call_mode: "reminder" } as unknown as Lead, null)).rejects.toMatchObject({
      code: "conflict",
    });
    // A human-triggered call is not held to the gap.
    await expect(
      service.placeCall({ ...base, call_mode: "confirmation" } as unknown as Lead, null),
    ).resolves.toMatchObject({ replayed: false });
  });

  it("is disabled by setting the cap to zero", async () => {
    const { service, repository } = await harness([], makeEnv({ MAX_CALLS_PER_LEAD: "0" }));
    for (let i = 0; i < 5; i++) await seedPriorCall(repository);
    const lead = {
      phone: "+919876543210", email: LEAD, first_name: "John", last_name: "", company: "", use_case: "",
      timezone: "Asia/Kolkata", call_mode: "booking", meeting_booked: false,
      meeting_id: null, meeting_start: null, meeting_end: null, meeting_link: null, meeting_owner: null,
      ae_email: null, ae_name: null,
    } as unknown as Lead;
    await expect(service.placeCall(lead, null)).resolves.toMatchObject({ replayed: false });
  });
});
