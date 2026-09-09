import { z } from "zod";

/**
 * Runtime validation for the Lyzr Voice APIs.
 *
 * The voice-agent CRUD schema is not publicly published, so agent config is
 * modelled as a permissive passthrough object: we clone whatever the base agent
 * holds rather than asserting a field list we cannot verify. Only the fields we
 * actually depend on are asserted.
 */

export const agentConfigSchema = z.record(z.unknown());

const agentBodySchema = z
  .object({
    // Different Lyzr surfaces have used `_id`, `id` and `agent_id`.
    _id: z.string().optional(),
    id: z.string().optional(),
    agent_id: z.string().optional(),
    name: z.string().optional(),
    config: agentConfigSchema.optional(),
  })
  .passthrough();

export type LyzrAgent = z.infer<typeof agentBodySchema>;

/**
 * GET /agents/{id} returns the agent wrapped in an `agent` envelope:
 *   { "agent": { "id", "config", "createdAt", "updatedAt", "updatedByUserId" } }
 *
 * Verified against the live API. The unwrapped form is still accepted so a
 * change of envelope on Lyzr's side does not break calling outright.
 */
export const lyzrAgentSchema = z.preprocess((value) => {
  if (value && typeof value === "object" && !Array.isArray(value) && "agent" in value) {
    return (value as { agent: unknown }).agent;
  }
  return value;
}, agentBodySchema);

/** Resolves whichever identifier field this deployment returned. */
export function extractAgentId(agent: LyzrAgent): string | null {
  return agent.agent_id ?? agent._id ?? agent.id ?? null;
}

/**
 * POST {LYZR_VOICE_API_BASE}/sessions/start
 *
 * Lyzr dispatches its voice agent into a LiveKit room and returns a
 * participant credential for us to join the same room. Verified against the
 * live API. (The older voice-sip WebSocket host no longer resolves in public
 * DNS and is not used.)
 */
export const liveKitSessionSchema = z
  .object({
    sessionId: z.string().min(1, "session response missing sessionId"),
    roomName: z.string().min(1, "session response missing roomName"),
    livekitUrl: z
      .string()
      .min(1, "session response missing livekitUrl")
      .refine((u) => /^wss?:\/\//i.test(u), "livekitUrl must be a ws:// or wss:// URL"),
    // The Lyzr-issued participant token. This is the ONLY credential needed -
    // no LiveKit API key or secret is involved.
    userToken: z.string().min(1, "session response missing userToken"),
    agentDispatched: z.boolean().optional(),
  })
  .passthrough();

export type LiveKitSession = z.infer<typeof liveKitSessionSchema>;

/**
 * Sample rate we publish the prospect's audio at.
 *
 * Twilio gives us 8 kHz; realtime voice models expect wideband, so the bridge
 * upsamples once here rather than letting the SDK guess. The rate of audio
 * coming BACK from the agent is never assumed - it is read from each frame.
 */
export const CAPTURE_SAMPLE_RATE = 24000;

/** Required Google Calendar actions - the call is refused without both. */
export const REQUIRED_CALENDAR_ACTIONS = [
  "GOOGLECALENDAR_FIND_FREE_SLOTS",
  "GOOGLECALENDAR_CREATE_EVENT",
] as const;

/**
 * Server-managed or sensitive fields that must never be copied into a clone.
 * Copying an id would target the base agent; copying a key would duplicate a
 * secret into a record we do not control.
 */
export const SANITIZED_AGENT_FIELDS = [
  "_id",
  "id",
  "agent_id",
  "user_id",
  "session_id",
  "createdAt",
  "updatedAt",
  "created_at",
  "updated_at",
  "updatedByUserId",
  "createdByUserId",
  "api_key",
  "apiKey",
  "x-api-key",
  "__v",
] as const;
