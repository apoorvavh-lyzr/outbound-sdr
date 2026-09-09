import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, mapTwilioStatus, resolveTransition } from "../src/calls/stateMachine.js";
import { CALL_STATUSES, isTerminal } from "../src/calls/types.js";

describe("call state transitions", () => {
  it("allows the full happy path", () => {
    const path = [
      "created", "agent_preparing", "agent_prepared", "queued",
      "initiated", "ringing", "answered", "stream_connecting", "streaming", "completed",
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("rejects backwards transitions", () => {
    expect(canTransition("answered", "ringing")).toBe(false);
    expect(canTransition("streaming", "queued")).toBe(false);
    expect(canTransition("completed", "answered")).toBe(false);
  });

  it("allows skipping intermediate states, since webhooks can be missed", () => {
    expect(canTransition("queued", "answered")).toBe(true);
    expect(canTransition("ringing", "completed")).toBe(true);
  });

  it("treats every terminal state as final", () => {
    for (const status of CALL_STATUSES.filter(isTerminal)) {
      for (const target of CALL_STATUSES) {
        if (target === status) continue;
        expect(canTransition(status, target)).toBe(false);
      }
    }
  });

  it("treats a repeat of the same status as valid (webhook replay)", () => {
    for (const status of CALL_STATUSES) expect(canTransition(status, status)).toBe(true);
  });

  it("can always fail or cancel from a non-terminal state", () => {
    for (const status of CALL_STATUSES.filter((s) => !isTerminal(s))) {
      expect(canTransition(status, "failed")).toBe(true);
      expect(canTransition(status, "canceled")).toBe(true);
    }
  });

  it("reaches the stream states even if the answered webhook never arrives", () => {
    // Twilio opening the media stream proves the prospect picked up, so a
    // delayed or dropped "answered" callback must not strand the call.
    for (const from of ["queued", "initiated", "ringing"] as const) {
      expect(canTransition(from, "stream_connecting")).toBe(true);
      expect(canTransition(from, "streaming")).toBe(true);
      expect(resolveTransition(from, "streaming")).toBe("streaming");
    }
  });

  it("throws on an invalid transition", () => {
    expect(() => assertTransition("completed", "ringing")).toThrow(/Invalid call state transition/);
    expect(() => assertTransition("created", "agent_preparing")).not.toThrow();
  });
});

describe("resolveTransition", () => {
  it("advances on a valid transition", () => {
    expect(resolveTransition("ringing", "answered")).toBe("answered");
  });

  it("ignores a late or out-of-order webhook instead of corrupting state", () => {
    expect(resolveTransition("answered", "ringing")).toBe("answered");
  });

  it("never leaves a terminal state", () => {
    expect(resolveTransition("completed", "ringing")).toBe("completed");
    expect(resolveTransition("failed", "completed")).toBe("failed");
  });
});

describe("mapTwilioStatus", () => {
  it.each([
    ["queued", "queued"], ["initiated", "initiated"], ["ringing", "ringing"],
    ["in-progress", "answered"], ["completed", "completed"], ["busy", "busy"],
    ["no-answer", "no_answer"], ["failed", "failed"], ["canceled", "canceled"],
  ])("maps %s -> %s", (twilio, internal) => {
    expect(mapTwilioStatus(twilio)).toBe(internal);
  });

  it("is case and whitespace tolerant", () => {
    expect(mapTwilioStatus("  In-Progress ")).toBe("answered");
  });

  it("returns null for an unknown status", () => {
    expect(mapTwilioStatus("teleported")).toBeNull();
  });
});
