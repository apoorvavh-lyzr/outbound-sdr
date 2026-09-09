import { z } from "zod";

export const CALL_MODES = ["booking", "confirmation"] as const;
export type CallMode = (typeof CALL_MODES)[number];

export const CALL_STATUSES = [
  "created",
  "agent_preparing",
  "agent_prepared",
  "queued",
  "initiated",
  "ringing",
  "answered",
  "stream_connecting",
  "streaming",
  "completed",
  "busy",
  "no_answer",
  "failed",
  "canceled",
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const TERMINAL_STATUSES = ["completed", "busy", "no_answer", "failed", "canceled"] as const satisfies readonly CallStatus[];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export function isTerminal(status: CallStatus): status is TerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** E.164: leading +, first digit 1-9, up to 15 digits total. */
export const e164 = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, "phone must be E.164 formatted, e.g. +919999999999");

const emptyToNull = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v === undefined || v === null || v.trim() === "" ? null : v.trim()));

const optionalText = (fallback: string) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v === undefined || v === null || v.trim() === "" ? fallback : v.trim()));

const looseBool = z
  .union([z.boolean(), z.string(), z.null(), z.undefined()])
  .transform((v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return ["1", "true", "yes"].includes(v.trim().toLowerCase());
    return false;
  });

export const leadSchema = z
  .object({
    phone: e164,
    email: z.string().trim().toLowerCase().email("email must be a valid address"),
    call_mode: z.enum(CALL_MODES, {
      errorMap: () => ({ message: "call_mode must be 'booking' or 'confirmation'" }),
    }),

    first_name: optionalText("there"),
    last_name: optionalText(""),
    company: optionalText(""),
    use_case: optionalText(""),
    timezone: optionalText("Asia/Kolkata"),

    meeting_booked: looseBool,
    meeting_id: emptyToNull,
    meeting_start: emptyToNull,
    meeting_end: emptyToNull,
    meeting_link: emptyToNull,
    meeting_owner: emptyToNull,
  })
  .superRefine((lead, ctx) => {
    if (lead.call_mode === "confirmation" && !lead.meeting_booked) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meeting_booked"],
        message: "meeting_booked must be true when call_mode is 'confirmation'",
      });
    }
    if (lead.call_mode === "confirmation" && !lead.meeting_start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["meeting_start"],
        message: "meeting_start is required when call_mode is 'confirmation'",
      });
    }
  })
  .transform((lead) => ({
    ...lead,
    // Booking mode never carries a pre-existing meeting.
    meeting_booked: lead.call_mode === "booking" ? false : lead.meeting_booked,
  }));

export type Lead = z.infer<typeof leadSchema>;

/** What the call actually achieved. Only ever populated from real evidence. */
export interface CallOutcome {
  status: CallStatus;
  meeting_booked_during_call?: boolean;
  meeting_confirmed?: boolean;
  reschedule_required?: boolean;
  preferred_replacement_slot?: string | null;
  prospect_not_interested?: boolean;
  do_not_call?: boolean;
  prospect_notes?: string | null;
}

export interface CallRecord {
  id: string;
  idempotency_key: string | null;

  phone: string;
  email: string;
  first_name: string;
  last_name: string;
  company: string;
  use_case: string;
  call_mode: CallMode;
  timezone: string;

  meeting_booked: boolean;
  meeting_id: string | null;
  meeting_start: string | null;
  meeting_end: string | null;
  meeting_link: string | null;
  meeting_owner: string | null;

  status: CallStatus;

  twilio_call_sid: string | null;
  twilio_stream_sid: string | null;

  lyzr_base_agent_id: string | null;
  lyzr_call_agent_id: string | null;
  lyzr_session_id: string | null;

  reschedule_required: boolean;
  preferred_replacement_slot: string | null;
  prospect_notes: string | null;

  error_code: string | null;
  error_message: string | null;

  created_at: string;
  updated_at: string;
  answered_at: string | null;
  completed_at: string | null;

  raw_twilio_status: unknown | null;
  metadata: Record<string, unknown> | null;
}

/** The public shape returned by GET /api/calls/:callId - never includes secrets. */
export function sanitizeCall(call: CallRecord) {
  return {
    call_id: call.id,
    status: call.status,
    phone: call.phone,
    email: call.email,
    call_mode: call.call_mode,
    twilio_call_sid: call.twilio_call_sid,
    lyzr_agent_id: call.lyzr_call_agent_id,
    lyzr_session_id: call.lyzr_session_id,
    reschedule_required: call.reschedule_required,
    preferred_replacement_slot: call.preferred_replacement_slot,
    created_at: call.created_at,
    answered_at: call.answered_at,
    completed_at: call.completed_at,
    error: call.error_code ? { code: call.error_code, message: call.error_message } : null,
  };
}
