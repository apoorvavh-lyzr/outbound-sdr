import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CloneAgentStrategy } from "../src/lyzr/contextStrategy.js";
import { missingCalendarActions } from "../src/lyzr/client.js";
import { extractAgentId, lyzrAgentSchema } from "../src/lyzr/schemas.js";
import { leadSchema, type Lead } from "../src/calls/types.js";

/**
 * Captured from the live API (GET /v1/agents/6aa13809b4c51e185bbca6ba), with
 * the api_key, credential ids and lead email replaced by sentinels.
 *
 * These tests pin the response SHAPE, which is not published: the `agent`
 * envelope, where the calendar actions live, and the fact that every dynamic
 * variable default is a string.
 */
const realResponse = JSON.parse(
  readFileSync(new URL("./fixtures/baseAgent.json", import.meta.url), "utf8"),
) as unknown;

const lead: Lead = leadSchema.parse({
  phone: "+919999999999",
  email: "apoorva@example.com",
  call_mode: "confirmation",
  first_name: "Apoorva",
  last_name: "VH",
  company: "Acme",
  use_case: "support agent",
  meeting_booked: true,
  meeting_id: "evt_1",
  meeting_start: "2026-09-15T10:00:00+05:30",
});

describe("real GET /agents response", () => {
  it("unwraps the `agent` envelope", () => {
    const agent = lyzrAgentSchema.parse(realResponse);
    expect(agent.config).toBeDefined();
    expect(agent.config?.agent_name).toBe("LYZR Demo SDR");
  });

  it("resolves the agent id from the envelope", () => {
    expect(extractAgentId(lyzrAgentSchema.parse(realResponse))).toBe("6aa13809b4c51e185bbca6ba");
  });

  it("still accepts an unwrapped body, in case the envelope changes", () => {
    const inner = (realResponse as { agent: unknown }).agent;
    expect(lyzrAgentSchema.parse(inner).config?.agent_name).toBe("LYZR Demo SDR");
  });

  it("finds the calendar actions where they really live (lyzr_tools[].action_names)", () => {
    const agent = lyzrAgentSchema.parse(realResponse);
    expect(missingCalendarActions(agent.config)).toEqual([]);
  });

  it("confirms the base agent's dynamic variables are all strings", () => {
    const agent = lyzrAgentSchema.parse(realResponse);
    const defaults = agent.config?.dynamic_variable_defaults as Record<string, unknown>;
    for (const value of Object.values(defaults)) expect(typeof value).toBe("string");
  });
});

describe("clone payload built from the real config", () => {
  const strategy = new CloneAgentStrategy({} as never);
  const agent = lyzrAgentSchema.parse(realResponse);
  const built = strategy.buildClonePayload(agent, lead, "call-abc");
  const config = built.body.config as Record<string, unknown>;

  it("passes the calendar-tool gate", () => {
    expect(missingCalendarActions(built.body)).toEqual([]);
  });

  it("strips the api_key that the real config embeds", () => {
    expect(config).not.toHaveProperty("api_key");
    expect(JSON.stringify(built.body)).not.toContain("SENTINEL");
    expect(built.removed).toContain("api_key");
  });

  it("injects this lead's context over the base defaults", () => {
    const vars = config.dynamic_variable_defaults as Record<string, string>;
    expect(vars.first_name).toBe("Apoorva");
    expect(vars.call_mode).toBe("confirmation");
    expect(vars.meeting_booked).toBe("true");
    expect(vars.meeting_id).toBe("evt_1");
    // The base agent has no last_name default; the merge adds it.
    expect(vars.last_name).toBe("VH");
  });

  it("preserves the prompt, instructions and engine configuration", () => {
    expect(config.prompt).toBe(agent.config?.prompt);
    expect(config.agent_instructions).toBe(agent.config?.agent_instructions);
    expect(config.engine).toEqual(agent.config?.engine);
    expect(config.background_audio).toEqual(agent.config?.background_audio);
  });

  it("keeps the Composio credential reference the calendar tools need", () => {
    const tools = config.lyzr_tools as Array<Record<string, unknown>>;
    expect(tools[0]!.credential_id).toBeDefined();
    expect(tools[0]!.tool_source).toBe("composio");
  });

  it("gives the clone a unique name", () => {
    expect(config.agent_name).toBe("LYZR Demo SDR - outbound - call-abc");
  });

  it("sets the agent to speak first and keeps the greeting it needs", () => {
    const start = config.conversation_start as Record<string, unknown>;
    expect(start.who).toBe("ai");
    // The API rejects who:"ai" without a greeting, so it must survive cloning.
    expect(typeof start.greeting).toBe("string");
    expect((start.greeting as string).length).toBeGreaterThan(0);
  });
});
