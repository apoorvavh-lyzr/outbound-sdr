import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSessionConfig, selectContextStrategy, SessionConfigStrategy, CloneAgentStrategy } from "../src/lyzr/contextStrategy.js";
import { lyzrAgentSchema } from "../src/lyzr/schemas.js";
import { leadSchema, type Lead } from "../src/calls/types.js";

const realAgent = lyzrAgentSchema.parse(
  JSON.parse(readFileSync(new URL("./fixtures/baseAgent.json", import.meta.url), "utf8")),
);
const baseConfig = realAgent.config as Record<string, unknown>;

const lead: Lead = leadSchema.parse({
  phone: "+919999999999",
  email: "apoorva@example.com",
  call_mode: "booking",
  first_name: "Apoorva",
  last_name: "VH",
  company: "Lyzr",
  use_case: "AI agent",
  timezone: "Asia/Kolkata",
});

describe("buildSessionConfig", () => {
  const config = buildSessionConfig(baseConfig, lead);
  const start = config.conversation_start as Record<string, unknown>;
  const vars = config.dynamic_variable_defaults as Record<string, string>;

  it("sends only per-session overrides, not a whole agent", () => {
    expect(Object.keys(config).sort()).toEqual(["conversation_start", "dynamic_variable_defaults"]);
  });

  it("makes the agent speak first", () => {
    expect(start.who).toBe("ai");
  });

  it("ALWAYS carries a greeting, which the API requires when who is 'ai'", () => {
    // Without it /sessions/start returns 400, and an agent told to speak first
    // with nothing to say stays silent.
    expect(typeof start.greeting).toBe("string");
    expect((start.greeting as string).length).toBeGreaterThan(0);
  });

  it("reuses the base agent's own greeting rather than inventing one", () => {
    const baseStart = baseConfig.conversation_start as Record<string, unknown>;
    expect(start.greeting).toBe(baseStart.greeting);
  });

  it("injects this lead's context", () => {
    expect(vars.first_name).toBe("Apoorva");
    expect(vars.company).toBe("Lyzr");
    expect(vars.call_mode).toBe("booking");
    expect(vars.meeting_booked).toBe("false");
    expect(vars.timezone).toBe("Asia/Kolkata");
    expect(vars.time_zone).toBe("Asia/Kolkata");
  });

  it("preserves unrelated base defaults", () => {
    expect(Object.keys(vars).length).toBeGreaterThanOrEqual(15);
  });

  it("does not mutate the base config", () => {
    const before = JSON.stringify(baseConfig);
    buildSessionConfig(baseConfig, lead);
    expect(JSON.stringify(baseConfig)).toBe(before);
  });

  it("still produces a greeting key when the base agent lacks one", () => {
    const bare = buildSessionConfig({ conversation_start: { who: "human" } }, lead);
    expect((bare.conversation_start as Record<string, unknown>).greeting).toBe("");
  });
});

describe("SessionConfigStrategy", () => {
  const fakeClient = (config: unknown) =>
    ({ getAgent: async () => ({ config }) }) as never;

  it("reuses the base agent and creates nothing", async () => {
    const prepared = await new SessionConfigStrategy(fakeClient(baseConfig)).prepareCallAgent(
      "6aa13809b4c51e185bbca6ba", lead, "call-1",
    );
    expect(prepared.agentId).toBe("6aa13809b4c51e185bbca6ba");
    expect(prepared.cloned).toBe(false);
    expect(prepared.sessionConfig).toBeDefined();
  });

  it("refuses to dial when the base agent lost its calendar tools", async () => {
    await expect(
      new SessionConfigStrategy(fakeClient({ conversation_start: { who: "ai", greeting: "hi" } }))
        .prepareCallAgent("base", lead, "call-2"),
    ).rejects.toThrow(/calendar actions/);
  });

  it("refuses to dial when there is no greeting to speak", async () => {
    const noGreeting = { ...baseConfig, conversation_start: { who: "ai" } };
    await expect(
      new SessionConfigStrategy(fakeClient(noGreeting)).prepareCallAgent("base", lead, "call-3"),
    ).rejects.toThrow(/greeting/);
  });
});

describe("selectContextStrategy", () => {
  it("reuses the saved agent by default", () => {
    expect(selectContextStrategy({} as never)).toBeInstanceOf(SessionConfigStrategy);
    expect(selectContextStrategy({} as never, false)).toBeInstanceOf(SessionConfigStrategy);
  });

  it("only clones when explicitly enabled", () => {
    expect(selectContextStrategy({} as never, true)).toBeInstanceOf(CloneAgentStrategy);
  });
});
