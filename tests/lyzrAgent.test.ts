import { describe, expect, it } from "vitest";
import {
  collectActionNames,
  extractUnrecognizedKeys,
  missingCalendarActions,
  sanitizeAgentConfig,
  stripKeys,
} from "../src/lyzr/client.js";
import {
  CONVERSATION_START_WHO,
  CloneAgentStrategy,
  applyOutboundConversationStart,
  buildDynamicVariables,
  mergeDynamicVariables,
} from "../src/lyzr/contextStrategy.js";
import { leadSchema, type Lead } from "../src/calls/types.js";
import { extractAgentId, liveKitSessionSchema } from "../src/lyzr/schemas.js";

const lead: Lead = leadSchema.parse({
  phone: "+919999999999",
  email: "apoorva@example.com",
  call_mode: "confirmation",
  first_name: "Apoorva",
  last_name: "VH",
  company: "Acme",
  use_case: "support agent",
  timezone: "Asia/Kolkata",
  meeting_booked: true,
  meeting_id: "evt_1",
  meeting_start: "2026-09-15T10:00:00+05:30",
  meeting_end: "2026-09-15T10:30:00+05:30",
  meeting_link: null,
  meeting_owner: null,
});

/** Mirrors the shape of the real base agent config. */
const baseAgentConfig = {
  _id: "6aa13809b4c51e185bbca6ba",
  user_id: "user_1",
  api_key: "sk-should-never-be-copied",
  createdAt: "2026-01-01T00:00:00Z",
  updatedByUserId: "user_1",
  prompt: "You are the Lyzr Demo SDR.",
  agent_instructions: "Be concise.",
  conversation_start: { who: "ai", message: "Hi!" },
  dynamic_variable_defaults: { first_name: "there", custom_field: "keep-me" },
  tools: [
    { provider: "composio", actions: ["GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_CREATE_EVENT"] },
  ],
  realtime: { provider: "openai", nested: { _id: "nested-id", voice: "alloy" } },
};

describe("sanitizeAgentConfig", () => {
  it("removes server-managed and sensitive fields at every depth", () => {
    const { config, removed } = sanitizeAgentConfig(baseAgentConfig);

    expect(config).not.toHaveProperty("_id");
    expect(config).not.toHaveProperty("user_id");
    expect(config).not.toHaveProperty("api_key");
    expect(config).not.toHaveProperty("createdAt");
    expect(config).not.toHaveProperty("updatedByUserId");
    const realtime = config.realtime as Record<string, Record<string, unknown>>;
    expect(realtime.nested).not.toHaveProperty("_id");

    expect(removed).toEqual(expect.arrayContaining(["_id", "user_id", "api_key"]));
  });

  it("reports removed field NAMES without leaking any value", () => {
    const { removed } = sanitizeAgentConfig(baseAgentConfig);
    expect(removed.join(",")).not.toContain("sk-should-never-be-copied");
  });

  it("preserves everything else, including calendar tooling", () => {
    const { config } = sanitizeAgentConfig(baseAgentConfig);
    expect(config.prompt).toBe(baseAgentConfig.prompt);
    expect(config.agent_instructions).toBe("Be concise.");
    expect(missingCalendarActions(config)).toEqual([]);
    const realtime = config.realtime as Record<string, Record<string, unknown>>;
    expect(realtime.nested?.voice).toBe("alloy");
  });

  it("does not mutate the source config", () => {
    const snapshot = JSON.stringify(baseAgentConfig);
    sanitizeAgentConfig(baseAgentConfig);
    expect(JSON.stringify(baseAgentConfig)).toBe(snapshot);
  });
});

describe("calendar tool verification", () => {
  it("finds actions regardless of nesting", () => {
    const actions = collectActionNames({ a: { b: [{ c: "GOOGLECALENDAR_CREATE_EVENT" }] } });
    expect(actions.has("GOOGLECALENDAR_CREATE_EVENT")).toBe(true);
  });

  it("reports nothing missing when both required actions are present", () => {
    expect(missingCalendarActions(baseAgentConfig)).toEqual([]);
  });

  it("reports a missing FIND_FREE_SLOTS", () => {
    const config = { tools: [{ actions: ["GOOGLECALENDAR_CREATE_EVENT"] }] };
    expect(missingCalendarActions(config)).toEqual(["GOOGLECALENDAR_FIND_FREE_SLOTS"]);
  });

  it("reports both as missing on an empty config", () => {
    expect(missingCalendarActions({})).toEqual([
      "GOOGLECALENDAR_FIND_FREE_SLOTS",
      "GOOGLECALENDAR_CREATE_EVENT",
    ]);
  });

  it("does not treat DELETE_EVENT as satisfying the requirement", () => {
    expect(missingCalendarActions({ tools: [{ actions: ["GOOGLECALENDAR_DELETE_EVENT"] }] })).toHaveLength(2);
  });
});

describe("dynamic variables", () => {
  it("stringifies every value, per the base agent's string-typed defaults", () => {
    const vars = buildDynamicVariables(lead);
    for (const value of Object.values(vars)) expect(typeof value).toBe("string");
  });

  it("maps booleans to 'true'/'false' rather than JSON booleans", () => {
    expect(buildDynamicVariables(lead).meeting_booked).toBe("true");
    const booking = leadSchema.parse({ phone: "+919999999999", email: "a@b.com", call_mode: "booking" });
    expect(buildDynamicVariables(booking).meeting_booked).toBe("false");
  });

  it("renders nulls as empty strings, never the literal 'null'", () => {
    const vars = buildDynamicVariables(lead);
    expect(vars.meeting_link).toBe("");
    expect(vars.meeting_owner).toBe("");
    expect(Object.values(vars)).not.toContain("null");
  });

  it("supplies both timezone spellings the base agent uses", () => {
    const vars = buildDynamicVariables(lead);
    expect(vars.timezone).toBe("Asia/Kolkata");
    expect(vars.time_zone).toBe("Asia/Kolkata");
  });

  it("covers every variable the base agent references", () => {
    expect(Object.keys(buildDynamicVariables(lead)).sort()).toEqual([
      "call_mode", "company", "email", "first_name", "last_name", "meeting_booked",
      "meeting_end", "meeting_id", "meeting_link", "meeting_owner", "meeting_start",
      "phone", "time_zone", "timezone", "use_case",
    ]);
  });

  it("overrides base defaults while preserving unrelated ones", () => {
    const merged = mergeDynamicVariables(baseAgentConfig.dynamic_variable_defaults, lead);
    expect(merged.first_name).toBe("Apoorva");
    expect(merged.custom_field).toBe("keep-me");
  });

  it("tolerates a missing or malformed base defaults object", () => {
    expect(mergeDynamicVariables(undefined, lead).first_name).toBe("Apoorva");
    expect(mergeDynamicVariables("nonsense", lead).first_name).toBe("Apoorva");
    expect(mergeDynamicVariables([1, 2], lead).first_name).toBe("Apoorva");
  });
});

describe("applyOutboundConversationStart", () => {
  it("flips the base agent's inbound 'human' to 'ai' so we do not dial into silence", () => {
    const result = applyOutboundConversationStart({ conversation_start: { who: "human" } });
    expect(result.applied).toBe(true);
    expect(result.config.conversation_start).toEqual({ who: "ai" });
  });

  it("is a no-op when already set to 'ai'", () => {
    expect(applyOutboundConversationStart({ conversation_start: { who: "ai" } }).applied).toBe(false);
  });

  it("adds the field when the base config omits it", () => {
    const result = applyOutboundConversationStart({ prompt: "x" });
    expect(result.config.conversation_start).toEqual({ who: "ai" });
  });

  it("only ever emits a value the create endpoint accepts", () => {
    const result = applyOutboundConversationStart({ conversation_start: { who: "human" } });
    const who = (result.config.conversation_start as Record<string, unknown>).who;
    expect(CONVERSATION_START_WHO).toContain(who);
  });

  it("preserves sibling keys such as the opening message", () => {
    const result = applyOutboundConversationStart({ conversation_start: { who: "human", message: "Hi!" } });
    expect((result.config.conversation_start as Record<string, unknown>).message).toBe("Hi!");
  });
});

describe("CloneAgentStrategy.buildClonePayload", () => {
  const strategy = new CloneAgentStrategy({} as never);
  const built = strategy.buildClonePayload({ config: baseAgentConfig }, lead, "call-123");
  const config = built.body.config as Record<string, unknown>;

  it("wraps the payload in the `config` envelope the create endpoint requires", () => {
    expect(Object.keys(built.body)).toEqual(["config"]);
  });

  it("renames the clone via agent_name, since there is no root `name` key", () => {
    expect(config.agent_name).toBe("LYZR Demo SDR - outbound - call-123");
    expect(built.body).not.toHaveProperty("name");
  });

  it("injects lead context", () => {
    const vars = config.dynamic_variable_defaults as Record<string, string>;
    expect(vars.first_name).toBe("Apoorva");
    expect(vars.call_mode).toBe("confirmation");
    expect(vars.meeting_id).toBe("evt_1");
    expect(vars.custom_field).toBe("keep-me");
  });

  it("carries the calendar tools through", () => {
    expect(missingCalendarActions(built.body)).toEqual([]);
  });

  it("never carries an id or api key into the create payload", () => {
    expect(built.body).not.toHaveProperty("_id");
    expect(built.body).not.toHaveProperty("api_key");
    expect(JSON.stringify(built.body)).not.toContain("sk-should-never-be-copied");
  });
});

describe("LiveKit session validation", () => {
  /** Captured from a live POST /v1/sessions/start. */
  const real = {
    userToken: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    roomName: "room-9d4f263a-10d6-47e0-af38-afb16b048c60",
    sessionId: "ef444437-203e-4cda-a210-da35dad6603e",
    livekitUrl: "wss://lyzr-4tysgnt4.livekit.cloud",
    agentDispatched: true,
    agentConfig: { engine: { kind: "realtime" }, tools: [] },
  };

  it("accepts the real response", () => {
    const session = liveKitSessionSchema.parse(real);
    expect(session.sessionId).toBe(real.sessionId);
    expect(session.roomName).toBe(real.roomName);
    expect(session.livekitUrl).toBe(real.livekitUrl);
    expect(session.userToken).toBe(real.userToken);
  });

  it("requires every field the bridge depends on", () => {
    for (const field of ["userToken", "roomName", "sessionId", "livekitUrl"] as const) {
      const { [field]: _omitted, ...rest } = real;
      expect(liveKitSessionSchema.safeParse(rest).success).toBe(false);
    }
  });

  it("rejects a livekitUrl that is not a websocket URL", () => {
    expect(liveKitSessionSchema.safeParse({ ...real, livekitUrl: "https://x" }).success).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(liveKitSessionSchema.safeParse({ ...real, userToken: "" }).success).toBe(false);
  });

  it("tolerates agentDispatched being absent", () => {
    const { agentDispatched: _d, ...rest } = real;
    expect(liveKitSessionSchema.safeParse(rest).success).toBe(true);
  });

  it("keeps unknown extra fields rather than stripping them", () => {
    const session = liveKitSessionSchema.parse(real) as Record<string, unknown>;
    expect(session.agentConfig).toBeDefined();
  });
});

describe("extractAgentId", () => {
  it("reads whichever identifier field the deployment returned", () => {
    expect(extractAgentId({ agent_id: "a" })).toBe("a");
    expect(extractAgentId({ _id: "b" })).toBe("b");
    expect(extractAgentId({ id: "c" })).toBe("c");
    expect(extractAgentId({})).toBeNull();
  });
});

describe("strict create-schema recovery", () => {
  /** Shape of the real 400 the create endpoint returns for unknown keys. */
  const rejection = {
    details: {
      body: JSON.stringify({
        error: 'Unrecognized keys: "agent_name", "conversation_start"',
        issues: [{ code: "unrecognized_keys", keys: ["agent_name", "conversation_start"], path: [] }],
      }),
    },
  };

  it("extracts the rejected key names", () => {
    expect(extractUnrecognizedKeys(rejection)).toEqual(["agent_name", "conversation_start"]);
  });

  it("returns nothing for unrelated errors", () => {
    expect(extractUnrecognizedKeys(new Error("boom"))).toEqual([]);
    expect(extractUnrecognizedKeys({ details: { body: "not json" } })).toEqual([]);
    expect(
      extractUnrecognizedKeys({ details: { body: JSON.stringify({ issues: [{ code: "invalid_value" }] }) } }),
    ).toEqual([]);
  });

  it("strips the named keys at any depth, leaving everything else", () => {
    const stripped = stripKeys(
      { config: { keep: 1, drop: 2, nested: { drop: 3, keep: 4 }, list: [{ drop: 5, keep: 6 }] } },
      ["drop"],
    ) as Record<string, Record<string, unknown>>;

    expect(stripped.config!.keep).toBe(1);
    expect(stripped.config).not.toHaveProperty("drop");
    expect(stripped.config!.nested).toEqual({ keep: 4 });
    expect(stripped.config!.list).toEqual([{ keep: 6 }]);
  });
});
