import { describe, expect, it } from "vitest";
import { leadSchema, sanitizeCall } from "../src/calls/types.js";
import type { CallRecord } from "../src/calls/types.js";

const bookingPayload = {
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

const confirmationPayload = {
  ...bookingPayload,
  call_mode: "confirmation",
  meeting_booked: true,
  meeting_id: "evt_123",
  meeting_start: "2026-09-15T10:00:00+05:30",
  meeting_end: "2026-09-15T10:30:00+05:30",
  meeting_link: "https://meet.google.com/abc-defg-hij",
  meeting_owner: "sdr@lyzr.ai",
};

describe("lead schema - booking mode", () => {
  it("accepts the documented SuperFlow booking payload", () => {
    const lead = leadSchema.parse(bookingPayload);
    expect(lead.call_mode).toBe("booking");
    expect(lead.meeting_booked).toBe(false);
  });

  it("applies optional defaults", () => {
    const lead = leadSchema.parse({ phone: "+919999999999", email: "a@b.com", call_mode: "booking" });
    expect(lead.first_name).toBe("there");
    expect(lead.last_name).toBe("");
    expect(lead.company).toBe("");
    expect(lead.use_case).toBe("");
    expect(lead.timezone).toBe("Asia/Kolkata");
  });

  it("forces meeting_booked false in booking mode", () => {
    // SuperFlow could send a stale true; booking mode means there is no meeting.
    const lead = leadSchema.parse({ ...bookingPayload, meeting_booked: true });
    expect(lead.meeting_booked).toBe(false);
  });

  it("normalises the email", () => {
    expect(leadSchema.parse({ ...bookingPayload, email: "  APOORVA@Example.COM " }).email).toBe(
      "apoorva@example.com",
    );
  });

  it("treats empty strings as absent", () => {
    const lead = leadSchema.parse({ ...bookingPayload, first_name: "  ", company: "" });
    expect(lead.first_name).toBe("there");
    expect(lead.company).toBe("");
  });
});

describe("lead schema - confirmation mode", () => {
  it("accepts the documented SuperFlow confirmation payload", () => {
    const lead = leadSchema.parse(confirmationPayload);
    expect(lead.meeting_booked).toBe(true);
    expect(lead.meeting_id).toBe("evt_123");
  });

  it("requires meeting_booked to be true", () => {
    const result = leadSchema.safeParse({ ...confirmationPayload, meeting_booked: false });
    expect(result.success).toBe(false);
  });

  it("requires meeting_start", () => {
    const result = leadSchema.safeParse({ ...confirmationPayload, meeting_start: null });
    expect(result.success).toBe(false);
  });

  it("does not fail when meeting_link or meeting_owner is missing", () => {
    const lead = leadSchema.parse({ ...confirmationPayload, meeting_link: null, meeting_owner: "" });
    expect(lead.meeting_link).toBeNull();
    expect(lead.meeting_owner).toBeNull();
  });

  it("accepts a stringified boolean from a workflow engine", () => {
    const lead = leadSchema.parse({ ...confirmationPayload, meeting_booked: "true" });
    expect(lead.meeting_booked).toBe(true);
  });
});

describe("E.164 validation", () => {
  it.each(["+919999999999", "+16263133414", "+442071838750"])("accepts %s", (phone) => {
    expect(leadSchema.safeParse({ ...bookingPayload, phone }).success).toBe(true);
  });

  it.each([
    ["missing plus", "919999999999"],
    ["leading zero", "+0919999999"],
    ["too short", "+9199"],
    ["too long", "+9199999999999999"],
    ["letters", "+91abcdefghij"],
    ["spaces", "+91 99999 99999"],
    ["empty", ""],
  ])("rejects %s", (_label, phone) => {
    expect(leadSchema.safeParse({ ...bookingPayload, phone }).success).toBe(false);
  });
});

describe("call_mode validation", () => {
  it("rejects an unknown mode", () => {
    const result = leadSchema.safeParse({ ...bookingPayload, call_mode: "reschedule" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/booking.*confirmation/);
    }
  });

  it("requires phone, email and call_mode", () => {
    const result = leadSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path[0]);
      expect(paths).toEqual(expect.arrayContaining(["phone", "email", "call_mode"]));
    }
  });

  it("rejects a malformed email", () => {
    expect(leadSchema.safeParse({ ...bookingPayload, email: "not-an-email" }).success).toBe(false);
  });
});

describe("sanitizeCall", () => {
  it("exposes only the documented fields", () => {
    const call = {
      id: "c1",
      status: "completed",
      phone: "+919999999999",
      email: "a@b.com",
      call_mode: "booking",
      twilio_call_sid: "CA1",
      lyzr_call_agent_id: "agent1",
      lyzr_session_id: "sess1",
      reschedule_required: false,
      preferred_replacement_slot: null,
      created_at: "t0",
      answered_at: null,
      completed_at: "t1",
      error_code: null,
      error_message: null,
    } as unknown as CallRecord;

    expect(Object.keys(sanitizeCall(call)).sort()).toEqual([
      "answered_at",
      "call_id",
      "call_mode",
      "completed_at",
      "created_at",
      "email",
      "error",
      "lyzr_agent_id",
      "lyzr_session_id",
      "phone",
      "preferred_replacement_slot",
      "reschedule_required",
      "status",
      "twilio_call_sid",
    ]);
  });

  it("surfaces an error object when the call failed", () => {
    const call = { error_code: "twilio_13224", error_message: "bad number" } as unknown as CallRecord;
    expect(sanitizeCall(call).error).toEqual({ code: "twilio_13224", message: "bad number" });
  });
});
