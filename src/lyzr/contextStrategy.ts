import { PreflightError } from "../utils/errors.js";
import { getLogger } from "../utils/logging.js";
import type { Lead } from "../calls/types.js";
import { LyzrClient, missingCalendarActions, sanitizeAgentConfig } from "./client.js";
import { extractAgentId, type LyzrAgent } from "./schemas.js";

export interface PreparedAgent {
  agentId: string;
  /** True when a per-call clone was created (and may later need cleanup). */
  cloned: boolean;
  strategy: string;
  removedFields: string[];
  /**
   * Per-session overrides POSTed to /sessions/start alongside the agent id.
   * This is how lead context reaches a REUSED agent without touching the
   * saved configuration.
   */
  sessionConfig?: Record<string, unknown>;
}

export interface AgentContextStrategy {
  readonly name: string;
  prepareCallAgent(baseAgentId: string, lead: Lead, callId: string): Promise<PreparedAgent>;
}

/**
 * The dynamic variables the base agent is known to reference.
 *
 * Lyzr's existing config uses string-valued dynamic variables, so booleans and
 * nulls are stringified rather than passed through as JSON types - a raw `null`
 * would render as the literal "null" mid-sentence on the call.
 */
export function buildDynamicVariables(lead: Lead): Record<string, string> {
  const text = (value: string | null | undefined) => value ?? "";

  return {
    first_name: text(lead.first_name),
    last_name: text(lead.last_name),
    email: text(lead.email),
    phone: text(lead.phone),
    company: text(lead.company),
    use_case: text(lead.use_case),
    call_mode: lead.call_mode,
    timezone: text(lead.timezone),
    // The base agent references both spellings.
    time_zone: text(lead.timezone),
    meeting_booked: lead.meeting_booked ? "true" : "false",
    meeting_id: text(lead.meeting_id),
    meeting_start: text(lead.meeting_start),
    meeting_end: text(lead.meeting_end),
    meeting_link: text(lead.meeting_link),
    meeting_owner: text(lead.meeting_owner),
  };
}

/**
 * Merges lead context over the base defaults. Unrelated defaults defined on the
 * base agent are preserved - we only ever override the keys we own.
 */
export function mergeDynamicVariables(
  baseDefaults: unknown,
  lead: Lead,
): Record<string, unknown> {
  const base =
    baseDefaults && typeof baseDefaults === "object" && !Array.isArray(baseDefaults)
      ? (baseDefaults as Record<string, unknown>)
      : {};

  return { ...base, ...buildDynamicVariables(lead) };
}

/** The accepted values for conversation_start.who, per the create endpoint. */
export const CONVERSATION_START_WHO = ["human", "ai"] as const;

/**
 * Forces the agent to speak first on an outbound call.
 *
 * The base agent is configured `{ who: "human" }`, which is right for inbound
 * but would leave dead air when WE dial the prospect - nobody expects to answer
 * their phone and be greeted by silence. Outbound therefore always sets "ai".
 *
 * The enum is not in the published docs, so it was confirmed against the create
 * endpoint's own validator, which rejects anything outside `"human" | "ai"`.
 */
export function applyOutboundConversationStart(
  config: Record<string, unknown>,
): { config: Record<string, unknown>; applied: boolean } {
  const existing = config.conversation_start;
  const start =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};

  if (start.who === "ai") return { config, applied: false };

  return {
    config: { ...config, conversation_start: { ...start, who: "ai" } },
    applied: true,
  };
}

/**
 * Builds the per-session `agentConfig` sent to /sessions/start.
 *
 * `conversation_start.greeting` is REQUIRED by the API whenever `who` is "ai",
 * so the base agent's own greeting is carried through. Omitting it is rejected,
 * and an agent told to speak first with nothing to say stays silent.
 */
export function buildSessionConfig(
  baseConfig: Record<string, unknown>,
  lead: Lead,
): Record<string, unknown> {
  const start =
    baseConfig.conversation_start && typeof baseConfig.conversation_start === "object"
      ? (baseConfig.conversation_start as Record<string, unknown>)
      : {};

  const greeting = typeof start.greeting === "string" ? start.greeting : "";

  return {
    dynamic_variable_defaults: mergeDynamicVariables(baseConfig.dynamic_variable_defaults, lead),
    conversation_start: { ...start, who: "ai", greeting },
  };
}

/**
 * DEFAULT STRATEGY: reuse the saved base agent and pass this lead's context as
 * per-session `agentConfig`.
 *
 * Nothing is created, so there is nothing to clean up and the permanent agent
 * is never touched - the saved configuration stays the single source of truth.
 */
export class SessionConfigStrategy implements AgentContextStrategy {
  readonly name = "session-config";
  private readonly log = getLogger().child({ component: "session-config-strategy" });

  constructor(private readonly client: LyzrClient) {}

  async prepareCallAgent(baseAgentId: string, lead: Lead, callId: string): Promise<PreparedAgent> {
    const base = await this.client.getAgent(baseAgentId);
    const config = (base.config ?? {}) as Record<string, unknown>;

    // The saved agent must still carry the calendar tooling; we just do not
    // modify it. A read-only check keeps the pre-dial guarantee intact.
    const missing = missingCalendarActions(config);
    if (missing.length > 0) {
      throw new PreflightError(
        "calendar_tools_missing",
        `Base agent is missing required calendar actions: ${missing.join(", ")}`,
        { missing },
      );
    }

    const sessionConfig = buildSessionConfig(config, lead);
    const greeting = (sessionConfig.conversation_start as Record<string, unknown>).greeting;
    if (!greeting) {
      throw new PreflightError(
        "missing_greeting",
        "Base agent has no conversation_start.greeting; an outbound agent set to speak first would stay silent",
      );
    }

    this.log.info(
      { event: "lyzr_runtime_context_prepared", callId, agentId: baseAgentId },
      "reusing saved agent with per-session context",
    );

    return { agentId: baseAgentId, cloned: false, strategy: this.name, removedFields: [], sessionConfig };
  }
}

/**
 * Clones the base voice agent per call, injecting this lead's context.
 *
 * WHY THIS IS THE DEFAULT: the documented external voice session endpoint
 * (POST /session/start) accepts only `{ agentId }`. There is no documented
 * runtime variable injection, so per-call context can only be delivered by
 * preparing an agent that already carries it.
 */
export class CloneAgentStrategy implements AgentContextStrategy {
  readonly name = "clone-agent";
  private readonly log = getLogger().child({ component: "clone-agent-strategy" });

  constructor(private readonly client: LyzrClient) {}

  async prepareCallAgent(baseAgentId: string, lead: Lead, callId: string): Promise<PreparedAgent> {
    const base = await this.client.getAgent(baseAgentId);
    this.log.info({ event: "lyzr_base_agent_loaded", callId, baseAgentId }, "loaded base agent");

    const payload = this.buildClonePayload(base, lead, callId);

    // Verify the calendar tooling survived the clone BEFORE creating anything.
    const missing = missingCalendarActions(payload.body);
    if (missing.length > 0) {
      throw new PreflightError(
        "calendar_tools_missing",
        `Prepared agent is missing required calendar actions: ${missing.join(", ")}`,
        { missing },
      );
    }

    const created = await this.client.createAgent(payload.body);
    const agentId = extractAgentId(created);
    if (!agentId) {
      throw new PreflightError("lyzr_clone_failed", "Cloned agent has no usable id");
    }

    this.log.info(
      {
        event: "lyzr_call_agent_created",
        callId,
        agentId,
        removedFields: payload.removed,
        conversationStartApplied: payload.conversationStartApplied,
      },
      "created per-call agent",
    );

    return { agentId, cloned: true, strategy: this.name, removedFields: payload.removed };
  }

  /**
   * Builds the create-agent request body. Pure - exposed for testing without
   * any network access.
   *
   * The create endpoint expects `{ config: {...} }` and validates keys
   * STRICTLY, rejecting anything it does not recognise. So the clone carries
   * the base agent's own fields (minus the sanitized denylist) and renames
   * itself via `agent_name` inside the config - there is no root `name` key.
   */
  buildClonePayload(
    base: LyzrAgent,
    lead: Lead,
    callId: string,
  ): { body: Record<string, unknown>; removed: string[]; conversationStartApplied: boolean } {
    const rawConfig = (base.config ?? {}) as Record<string, unknown>;
    const { config: sanitized, removed } = sanitizeAgentConfig(rawConfig);

    const withVariables: Record<string, unknown> = {
      ...sanitized,
      dynamic_variable_defaults: mergeDynamicVariables(sanitized.dynamic_variable_defaults, lead),
      agent_name: `LYZR Demo SDR - outbound - ${callId}`,
    };

    const { config: withStart, applied } = applyOutboundConversationStart(withVariables);

    return {
      body: { config: withStart },
      removed: [...new Set(removed)],
      conversationStartApplied: applied,
    };
  }
}

/**
 * Reuse of the saved agent is the production path. Cloning is only reachable by
 * explicitly setting LYZR_ENABLE_AGENT_CLONING, and is never the default.
 */
export function selectContextStrategy(client: LyzrClient, enableCloning = false): AgentContextStrategy {
  return enableCloning ? new CloneAgentStrategy(client) : new SessionConfigStrategy(client);
}
