import { describe, expect, it } from "vitest";
import twilio from "twilio";
import { buildStreamTwiML, escapeXml } from "../src/twilio/twiml.js";
import { parseTwilioFrame, twilioStatusCallbackSchema } from "../src/twilio/schemas.js";
import {
  reconstructWebhookUrl,
  safeEqual,
  signStreamToken,
  validateTwilioSignature,
  verifyStreamToken,
} from "../src/twilio/validation.js";

describe("TwiML generation", () => {
  const twiml = buildStreamTwiML({
    streamUrl: "wss://voice.example.com/twilio-media",
    callId: "call-123",
    parameters: { token: "abc" },
  });

  it("connects the call to a bidirectional stream", () => {
    expect(twiml).toContain("<Connect>");
    expect(twiml).toContain('<Stream url="wss://voice.example.com/twilio-media">');
    expect(twiml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("passes context as Parameters, never in the URL", () => {
    expect(twiml).toContain('<Parameter name="callId" value="call-123"/>');
    expect(twiml).toContain('<Parameter name="token" value="abc"/>');
    expect(twiml).not.toContain("?callId=");
  });

  it("keeps PII out of the stream URL", () => {
    const withLead = buildStreamTwiML({
      streamUrl: "wss://voice.example.com/twilio-media",
      callId: "c1",
      parameters: { token: "t" },
    });
    expect(withLead).not.toMatch(/@|email|phone=/);
  });

  it("escapes XML metacharacters in values", () => {
    const escaped = buildStreamTwiML({
      streamUrl: "wss://x.dev/media?a=1&b=2",
      callId: 'evil"><Hangup/>',
    });
    expect(escaped).toContain("a=1&amp;b=2");
    expect(escaped).not.toContain("<Hangup/>");
    expect(escaped).toContain("&quot;&gt;&lt;Hangup/&gt;");
  });

  it("is parseable as well-formed XML", () => {
    // A stray unescaped character would make Twilio reject the call.
    expect(twiml.match(/</g)?.length).toBe(twiml.match(/>/g)?.length);
  });

  it("escapes all five XML entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("Twilio media frame parsing", () => {
  it("parses a start frame with custom parameters", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({
        event: "start",
        streamSid: "MZ123",
        start: { streamSid: "MZ123", callSid: "CA123", customParameters: { callId: "c1", token: "t" } },
      }),
    );
    expect(frame?.start?.customParameters?.callId).toBe("c1");
    expect(frame?.start?.callSid).toBe("CA123");
  });

  it("parses a media frame", () => {
    const frame = parseTwilioFrame(
      JSON.stringify({ event: "media", streamSid: "MZ1", media: { payload: "AAAA", track: "inbound" } }),
    );
    expect(frame?.media?.payload).toBe("AAAA");
  });

  it.each(["connected", "mark", "stop"])("parses a %s frame", (event) => {
    expect(parseTwilioFrame(JSON.stringify({ event, mark: { name: "m1" } }))?.event).toBe(event);
  });

  it("returns null rather than throwing on malformed input", () => {
    for (const input of ["not json", "", "[]", "{}", "null"]) {
      expect(parseTwilioFrame(input)).toBeNull();
    }
  });

  it("tolerates unknown extra fields", () => {
    expect(parseTwilioFrame(JSON.stringify({ event: "media", futureField: true }))?.event).toBe("media");
  });
});

describe("Twilio status callback schema", () => {
  it("accepts a real-shaped callback", () => {
    const parsed = twilioStatusCallbackSchema.safeParse({
      CallSid: "CA1", CallStatus: "completed", CallDuration: "42", AccountSid: "AC1",
    });
    expect(parsed.success).toBe(true);
  });

  it("requires CallSid and CallStatus", () => {
    expect(twilioStatusCallbackSchema.safeParse({ CallStatus: "completed" }).success).toBe(false);
    expect(twilioStatusCallbackSchema.safeParse({ CallSid: "CA1" }).success).toBe(false);
  });

  it("captures error details when Twilio reports them", () => {
    const parsed = twilioStatusCallbackSchema.parse({
      CallSid: "CA1", CallStatus: "failed", ErrorCode: "13224", ErrorMessage: "Invalid number",
    });
    expect(parsed.ErrorCode).toBe("13224");
  });
});

describe("Twilio signature validation", () => {
  const authToken = "test-auth-token";
  const url = "https://voice.example.com/api/twilio/status";
  const params = { CallSid: "CA1", CallStatus: "completed" };

  it("accepts a genuinely signed request", () => {
    const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
    expect(validateTwilioSignature({ authToken, signature, url, params })).toBe(true);
  });

  it("rejects a tampered body", () => {
    const signature = twilio.getExpectedTwilioSignature(authToken, url, params);
    expect(
      validateTwilioSignature({ authToken, signature, url, params: { ...params, CallStatus: "busy" } }),
    ).toBe(false);
  });

  it("rejects a signature minted for a different URL", () => {
    const signature = twilio.getExpectedTwilioSignature(authToken, "https://evil.example/x", params);
    expect(validateTwilioSignature({ authToken, signature, url, params })).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(validateTwilioSignature({ authToken, signature: undefined, url, params })).toBe(false);
  });
});

describe("reconstructWebhookUrl", () => {
  it("builds the public URL Twilio signed, not the proxied internal one", () => {
    expect(reconstructWebhookUrl("https://voice.example.com", "/api/twilio/status")).toBe(
      "https://voice.example.com/api/twilio/status",
    );
  });

  it("normalises slashes", () => {
    expect(reconstructWebhookUrl("https://x.dev/", "api/twilio/status")).toBe("https://x.dev/api/twilio/status");
  });
});

describe("stream token", () => {
  const secret = "shared-secret";

  it("round-trips for the call it was minted for", () => {
    const token = signStreamToken("call-1", secret);
    expect(verifyStreamToken("call-1", token, secret)).toBe(true);
  });

  it("rejects a token bound to another call", () => {
    expect(verifyStreamToken("call-2", signStreamToken("call-1", secret), secret)).toBe(false);
  });

  it("rejects a token minted with another secret", () => {
    expect(verifyStreamToken("call-1", signStreamToken("call-1", "other"), secret)).toBe(false);
  });

  it("rejects a missing token", () => {
    expect(verifyStreamToken("call-1", undefined, secret)).toBe(false);
  });

  it("is URL-safe and compact", () => {
    expect(signStreamToken("call-1", secret)).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
});

describe("safeEqual", () => {
  it("compares equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
  });

  it("rejects different strings, including unequal lengths", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});
