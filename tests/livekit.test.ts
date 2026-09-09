import { describe, expect, it } from "vitest";
import { ParticipantKind } from "@livekit/rtc-node";
import { isAgent } from "../src/livekit/roomBridge.js";
import { CAPTURE_SAMPLE_RATE } from "../src/lyzr/schemas.js";

describe("isAgent", () => {
  it("identifies a LiveKit-dispatched agent by kind", () => {
    expect(isAgent({ kind: ParticipantKind.AGENT, identity: "anything" })).toBe(true);
  });

  it("NEVER treats our own twilio-<callId> participant as the agent", () => {
    // Routing our own published track back would echo the prospect to themselves.
    expect(isAgent({ kind: ParticipantKind.STANDARD, identity: "twilio-abc-123" })).toBe(false);
    // Even a suspiciously named one.
    expect(isAgent({ kind: ParticipantKind.STANDARD, identity: "twilio-agent-1" })).toBe(false);
  });

  it("falls back to identity for agents joining as standard participants", () => {
    expect(isAgent({ kind: ParticipantKind.STANDARD, identity: "lyzr-voice-agent" })).toBe(true);
    expect(isAgent({ kind: ParticipantKind.STANDARD, identity: "agent-7" })).toBe(true);
  });

  it("ignores unrelated participants", () => {
    expect(isAgent({ kind: ParticipantKind.STANDARD, identity: "observer" })).toBe(false);
    expect(isAgent({ kind: ParticipantKind.STANDARD, identity: "" })).toBe(false);
    expect(isAgent({})).toBe(false);
  });

  it("does not mistake SIP or egress participants for the agent", () => {
    expect(isAgent({ kind: ParticipantKind.SIP, identity: "sip-caller" })).toBe(false);
    expect(isAgent({ kind: ParticipantKind.EGRESS, identity: "recorder" })).toBe(false);
  });
});

describe("capture rate", () => {
  it("publishes wideband audio, since Twilio's 8kHz is narrowband", () => {
    expect(CAPTURE_SAMPLE_RATE).toBe(24000);
  });

  it("divides evenly into 20ms frames", () => {
    expect((CAPTURE_SAMPLE_RATE * 20) / 1000).toBe(480);
    expect(Number.isInteger((CAPTURE_SAMPLE_RATE * 20) / 1000)).toBe(true);
  });
});
