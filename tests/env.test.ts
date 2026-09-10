import { describe, expect, it } from "vitest";
import { mediaStreamUrl, parseEnv } from "../src/config/env.js";

const mockBase = { MOCK_EXTERNAL_SERVICES: "true", NODE_ENV: "development" };

const productionBase = {
  NODE_ENV: "production",
  PUBLIC_BASE_URL: "https://voice.example.com",
  LYZR_API_KEY: "key",
  LYZR_BASE_AGENT_ID: "agent",
  TWILIO_ACCOUNT_SID: "AC1",
  TWILIO_AUTH_TOKEN: "tok",
  TWILIO_PHONE_NUMBER: "+16263133414",
  SUPERFLOW_SHARED_SECRET: "secret",
  SUPERFLOW_INTAKE_WEBHOOK_URL: "https://superflow.example.com/intake",
  SUPERFLOW_INTAKE_WEBHOOK_SECRET: "intake-secret",
  SUPERFLOW_INTAKE_WORKFLOW_ID: "667750cd-b2df-4f00-8aa9-a16d0a2f3004",
  DATABASE_URL: "postgres://user:pass@host:5432/db",
};

describe("env validation", () => {
  it("accepts a complete production configuration", () => {
    const env = parseEnv(productionBase as NodeJS.ProcessEnv);
    expect(env.NODE_ENV).toBe("production");
    expect(env.PORT).toBe(3000);
  });

  it("applies documented defaults", () => {
    const env = parseEnv(mockBase as NodeJS.ProcessEnv);
    expect(env.LYZR_VOICE_API_BASE).toBe("https://voice-livekit.studio.lyzr.ai/v1");
    expect(env.AUDIO_PRECONNECT_BUFFER_MS).toBe(1000);
    expect(env.MOCK_EXTERNAL_SERVICES).toBe(true);
  });

  it("treats empty strings as unset", () => {
    // .env files commonly contain KEY= with no value.
    const env = parseEnv({ ...mockBase, PUBLIC_BASE_URL: "   " } as NodeJS.ProcessEnv);
    expect(env.PUBLIC_BASE_URL).toBeUndefined();
  });

  it("requires live credentials when not mocking", () => {
    expect(() => parseEnv({ NODE_ENV: "development" } as NodeJS.ProcessEnv)).toThrow(/LYZR_API_KEY/);
  });

  it("lists every missing production variable at once", () => {
    try {
      parseEnv({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
      expect.unreachable("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("TWILIO_ACCOUNT_SID");
      expect(message).toContain("SUPERFLOW_SHARED_SECRET");
      expect(message).toContain("DATABASE_URL");
    }
  });

  it("rejects a PUBLIC_BASE_URL with no hostname", () => {
    // What https://${{RAILWAY_PUBLIC_DOMAIN}} expands to before a domain
    // exists. It passes a naive https:// prefix check but is unusable.
    expect(() =>
      parseEnv({ ...productionBase, PUBLIC_BASE_URL: "https://" } as NodeJS.ProcessEnv),
    ).toThrow(/no hostname|Generate Domain/);
  });

  it("rejects a non-https PUBLIC_BASE_URL in production", () => {
    expect(() =>
      parseEnv({ ...productionBase, PUBLIC_BASE_URL: "http://voice.example.com" } as NodeJS.ProcessEnv),
    ).toThrow(/https:\/\//);
  });

  it("still demands credentials in production even with mock mode on", () => {
    expect(() =>
      parseEnv({ NODE_ENV: "production", MOCK_EXTERNAL_SERVICES: "true" } as NodeJS.ProcessEnv),
    ).toThrow(/TWILIO_ACCOUNT_SID/);
  });

  it("rejects a relative SUPERFLOW_CALLBACK_URL", () => {
    expect(() => parseEnv({ ...mockBase, SUPERFLOW_CALLBACK_URL: "/hook" } as NodeJS.ProcessEnv)).toThrow(
      /absolute http/,
    );
  });

  it("coerces numeric and boolean strings", () => {
    const env = parseEnv({ ...mockBase, PORT: "8080", ENABLE_DNC_CHECK: "yes" } as NodeJS.ProcessEnv);
    expect(env.PORT).toBe(8080);
    expect(env.ENABLE_DNC_CHECK).toBe(true);
  });
});

describe("mediaStreamUrl", () => {
  it("upgrades https to wss", () => {
    const env = parseEnv(productionBase as NodeJS.ProcessEnv);
    expect(mediaStreamUrl(env)).toBe("wss://voice.example.com/twilio-media");
  });

  it("strips a trailing slash", () => {
    const env = parseEnv({ ...productionBase, PUBLIC_BASE_URL: "https://x.dev/" } as NodeJS.ProcessEnv);
    expect(mediaStreamUrl(env)).toBe("wss://x.dev/twilio-media");
  });

  it("falls back to a local ws:// URL when unset", () => {
    const env = parseEnv({ ...mockBase, PORT: "4000" } as NodeJS.ProcessEnv);
    expect(mediaStreamUrl(env)).toBe("ws://localhost:4000/twilio-media");
  });
});
