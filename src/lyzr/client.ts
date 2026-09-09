import { UpstreamError } from "../utils/errors.js";
import { isTransientHttpError, retry } from "../utils/retry.js";
import { withTimeout } from "../utils/timeout.js";
import { getLogger } from "../utils/logging.js";
import {
  REQUIRED_CALENDAR_ACTIONS,
  SANITIZED_AGENT_FIELDS,
  extractAgentId,
  liveKitSessionSchema,
  lyzrAgentSchema,
  type LiveKitSession,
  type LyzrAgent,
} from "./schemas.js";

export interface LyzrClientOptions {
  apiKey: string;
  voiceApiBase: string;
  timeoutMs: number;
  sessionTimeoutMs: number;
}

/** Deep clone that drops undefined and preserves plain JSON structure. */
function deepClone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Recursively collects every string that looks like a tool/action identifier,
 * so tool verification does not depend on the exact nesting Lyzr uses (which
 * is not publicly documented and has varied between surfaces).
 */
export function collectActionNames(node: unknown, found = new Set<string>()): Set<string> {
  if (typeof node === "string") {
    if (/^[A-Z][A-Z0-9_]{3,}$/.test(node)) found.add(node);
    return found;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectActionNames(item, found);
    return found;
  }
  if (node && typeof node === "object") {
    for (const value of Object.values(node)) collectActionNames(value, found);
  }
  return found;
}

/** Which required calendar actions are missing from a prepared agent config. */
export function missingCalendarActions(config: unknown): string[] {
  const actions = collectActionNames(config);
  return REQUIRED_CALENDAR_ACTIONS.filter((required) => !actions.has(required));
}

/**
 * Strips server-managed and sensitive fields, recursively. Returns the cleaned
 * object plus the field names removed, so the removal is auditable without
 * ever logging a value.
 */
export function sanitizeAgentConfig(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  removed: string[];
} {
  const removed: string[] = [];
  const banned = new Set<string>(SANITIZED_AGENT_FIELDS);

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node)) {
        if (banned.has(key)) {
          removed.push(key);
          continue;
        }
        out[key] = walk(value);
      }
      return out;
    }
    return node;
  };

  return { config: walk(deepClone(config)) as Record<string, unknown>, removed };
}

/**
 * Pulls the rejected field names out of a create-agent validation error.
 * The endpoint reports them as `{ code: "unrecognized_keys", keys: [...] }`.
 */
export function extractUnrecognizedKeys(err: unknown): string[] {
  const details = (err as { details?: { body?: unknown } })?.details;
  if (!details || typeof details.body !== "string") return [];

  try {
    const parsed = JSON.parse(details.body) as { issues?: Array<{ code?: string; keys?: unknown }> };
    const keys = (parsed.issues ?? [])
      .filter((issue) => issue.code === "unrecognized_keys")
      .flatMap((issue) => (Array.isArray(issue.keys) ? issue.keys : []))
      .filter((key): key is string => typeof key === "string");
    return [...new Set(keys)];
  } catch {
    return [];
  }
}

/** Removes `keys` at any depth, used only to satisfy a strict create schema. */
export function stripKeys(value: unknown, keys: string[]): unknown {
  const banned = new Set(keys);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node)
          .filter(([key]) => !banned.has(key))
          .map(([key, val]) => [key, walk(val)]),
      );
    }
    return node;
  };
  return walk(value);
}

export class LyzrClient {
  private readonly log = getLogger().child({ component: "lyzr-client" });

  constructor(private readonly options: LyzrClientOptions) {}

  private async request<T>(
    url: string,
    init: RequestInit,
    label: string,
    timeoutMs = this.options.timeoutMs,
  ): Promise<T> {
    return withTimeout(timeoutMs, label, async (signal) => {
      const response = await fetch(url, {
        ...init,
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          ...(init.headers ?? {}),
        },
      });

      const text = await response.text();
      if (!response.ok) {
        // Body may carry an upstream message; it must not carry our key back.
        throw new UpstreamError(
          "lyzr_http_error",
          `${label} failed with HTTP ${response.status}`,
          response.status >= 500 ? 502 : 422,
          { statusCode: response.status, body: text.slice(0, 500) },
        );
      }

      if (!text.trim()) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new UpstreamError("lyzr_invalid_json", `${label} returned a non-JSON body`, 502);
      }
    });
  }

  /** GET /agents/{agentId} - retried, since it is a safe read. */
  async getAgent(agentId: string): Promise<LyzrAgent> {
    const url = `${this.options.voiceApiBase.replace(/\/+$/, "")}/agents/${encodeURIComponent(agentId)}`;
    const raw = await retry(() => this.request<unknown>(url, { method: "GET" }, "lyzr getAgent"), {
      attempts: 3,
      isRetryable: isTransientHttpError,
      onRetry: (err, attempt) =>
        this.log.warn({ event: "lyzr_get_agent_retry", attempt, err: String(err) }, "retrying getAgent"),
    });

    const parsed = lyzrAgentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new UpstreamError("lyzr_invalid_agent", "Base agent response failed validation", 502, {
        issues: parsed.error.issues,
      });
    }
    return parsed.data;
  }

  /**
   * Creates a per-call clone of the base agent carrying this lead's context.
   *
   * Not retried on transient failures: a create is not idempotent, and retrying
   * after an ambiguous failure would orphan an agent that nothing can delete.
   *
   * There is exactly one retry, and only for a deterministic cause: the create
   * endpoint validates keys strictly and names the ones it rejects. If the base
   * agent grows a field the create schema does not accept, we drop precisely
   * those keys and try once more, rather than failing the call outright.
   */
  async createAgent(payload: Record<string, unknown>): Promise<LyzrAgent> {
    const url = `${this.options.voiceApiBase.replace(/\/+$/, "")}/agents`;

    let raw: unknown;
    try {
      raw = await this.request<unknown>(url, { method: "POST", body: JSON.stringify(payload) }, "lyzr createAgent");
    } catch (err) {
      const rejected = extractUnrecognizedKeys(err);
      if (rejected.length === 0) throw err;

      const stripped = stripKeys(payload, rejected);
      this.log.warn(
        { event: "lyzr_create_agent_retry", rejectedKeys: rejected },
        "create rejected unrecognized keys; retrying once without them",
      );
      raw = await this.request<unknown>(
        url,
        { method: "POST", body: JSON.stringify(stripped) },
        "lyzr createAgent (stricter allowlist)",
      );
    }

    const parsed = lyzrAgentSchema.safeParse(raw);
    if (!parsed.success || !extractAgentId(parsed.data)) {
      throw new UpstreamError("lyzr_invalid_create_response", "Agent create response missing an id", 502);
    }
    return parsed.data;
  }

  /**
   * Starts a voice session: Lyzr dispatches its agent into a LiveKit room and
   * returns the credential for us to join that same room.
   *
   * Retried on transient failures because this runs BEFORE any audio flows, so
   * a retry cannot interrupt a live conversation.
   */
  async startVoiceSession(
    agentId: string,
    userIdentity: string,
    agentConfig?: Record<string, unknown>,
  ): Promise<LiveKitSession> {
    const url = `${this.options.voiceApiBase.replace(/\/+$/, "")}/sessions/start`;

    const raw = await retry(
      () =>
        this.request<unknown>(
          url,
          {
            method: "POST",
            body: JSON.stringify({ agentId, userIdentity, ...(agentConfig ? { agentConfig } : {}) }),
          },
          "lyzr startVoiceSession",
          this.options.sessionTimeoutMs,
        ),
      {
        attempts: 3,
        isRetryable: isTransientHttpError,
        onRetry: (err, attempt) =>
          this.log.warn({ event: "lyzr_session_retry", attempt, err: String(err) }, "retrying session start"),
      },
    );

    const parsed = liveKitSessionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new UpstreamError("lyzr_invalid_session", "Voice session response failed validation", 502, {
        issues: parsed.error.issues,
      });
    }

    if (parsed.data.agentDispatched === false) {
      throw new UpstreamError("lyzr_agent_not_dispatched", "Lyzr did not dispatch an agent into the room", 502);
    }
    return parsed.data;
  }

  /**
   * Ends a voice session so Lyzr can tear down its side of the room.
   *
   * Best-effort: the call is already over by the time this runs, so a failure
   * is logged rather than surfaced.
   */
  async endVoiceSession(sessionId: string): Promise<void> {
    const url = `${this.options.voiceApiBase.replace(/\/+$/, "")}/sessions/end`;
    try {
      await this.request<unknown>(url, { method: "POST", body: JSON.stringify({ sessionId }) }, "lyzr endVoiceSession");
    } catch (err) {
      this.log.warn({ event: "lyzr_session_end_failed", err: String(err) }, "could not end voice session");
    }
  }

  /**
   * Deletes a cloned per-call agent.
   *
   * `DELETE /agents/{id}` is not in the published docs but was verified against
   * the live API: it returns 204 and subsequent reads 404. Without this every
   * outbound call would leak an agent permanently.
   *
   * A 404 is treated as success - the goal is that the agent no longer exists.
   */
  async deleteAgent(agentId: string): Promise<void> {
    const url = `${this.options.voiceApiBase.replace(/\/+$/, "")}/agents/${encodeURIComponent(agentId)}`;
    try {
      await this.request<unknown>(url, { method: "DELETE" }, "lyzr deleteAgent");
    } catch (err) {
      const status = (err as { details?: { statusCode?: number } })?.details?.statusCode;
      if (status === 404) return;
      throw err;
    }
  }

  readonly supportsAgentDeletion = true;
}
