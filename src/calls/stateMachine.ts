import { ConflictError } from "../utils/errors.js";
import { type CallStatus, isTerminal } from "./types.js";

/**
 * Legal forward transitions. Telephony events arrive out of order and Twilio
 * retries webhooks, so the machine is permissive about *skipping* states but
 * strict about going backwards or leaving a terminal state.
 */
const TRANSITIONS: Record<CallStatus, readonly CallStatus[]> = {
  created: ["agent_preparing", "failed", "canceled"],
  agent_preparing: ["agent_prepared", "failed", "canceled"],
  agent_prepared: ["queued", "failed", "canceled"],
  // Media-stream states are reachable directly from any pre-answer state:
  // Twilio opening the stream is itself proof the prospect picked up, and the
  // "answered" webhook may arrive late, out of order, or not at all.
  queued: [
    "initiated", "ringing", "answered", "stream_connecting", "streaming",
    "completed", "busy", "no_answer", "failed", "canceled",
  ],
  initiated: [
    "ringing", "answered", "stream_connecting", "streaming",
    "completed", "busy", "no_answer", "failed", "canceled",
  ],
  ringing: [
    "answered", "stream_connecting", "streaming",
    "completed", "busy", "no_answer", "failed", "canceled",
  ],
  answered: ["stream_connecting", "streaming", "completed", "failed", "canceled"],
  stream_connecting: ["streaming", "completed", "failed", "canceled"],
  streaming: ["completed", "failed", "canceled"],
  completed: [],
  busy: [],
  no_answer: [],
  failed: [],
  canceled: [],
};

export function canTransition(from: CallStatus, to: CallStatus): boolean {
  if (from === to) return true; // idempotent webhook replays
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CallStatus, to: CallStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(`Invalid call state transition: ${from} -> ${to}`);
  }
}

/**
 * Resolves a transition without throwing. Returns the status the record should
 * hold, so late/duplicate webhooks are ignored rather than corrupting state.
 */
export function resolveTransition(from: CallStatus, to: CallStatus): CallStatus {
  if (from === to) return from;
  if (isTerminal(from)) return from; // terminal is final
  return canTransition(from, to) ? to : from;
}

/** Twilio call status -> internal status. */
const TWILIO_STATUS_MAP: Record<string, CallStatus> = {
  queued: "queued",
  initiated: "initiated",
  ringing: "ringing",
  "in-progress": "answered",
  answered: "answered",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "canceled",
};

export function mapTwilioStatus(twilioStatus: string): CallStatus | null {
  return TWILIO_STATUS_MAP[twilioStatus.trim().toLowerCase()] ?? null;
}
