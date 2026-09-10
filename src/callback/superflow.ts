import type { Logger } from "pino";
import type { Env } from "../config/env.js";
import type { CallRepository } from "../db/repository.js";
import { isTransientHttpError, retry } from "../utils/retry.js";
import { withTimeout } from "../utils/timeout.js";
import type { CallRecord } from "../calls/types.js";

/** Payload posted to SuperFlow when a call reaches a terminal status. */
export function buildCallbackPayload(call: CallRecord) {
  return {
    // Always OUR internal call id - never the Twilio SID. SuperFlow calls
    // GET /api/calls/:callId/transcript with exactly this value.
    call_id: call.id,
    twilio_call_sid: call.twilio_call_sid,
    status: call.status,
    first_name: call.first_name,
    last_name: call.last_name,
    email: call.email,
    phone: call.phone,
    company: call.company,
    use_case: call.use_case,
    call_mode: call.call_mode,
    timezone: call.timezone,
    lyzr_session_id: call.lyzr_session_id,
    reschedule_required: call.reschedule_required,
    preferred_replacement_slot: call.preferred_replacement_slot,
    completed_at: call.completed_at,
  };
}

/**
 * Notifies SuperFlow that a call finished.
 *
 * SuperFlow owns the business follow-up (transcript fetch, summary, email), so
 * this is a fire-and-forget notification. A callback failure is logged and
 * persisted but MUST NOT alter the call's real status - the phone call either
 * happened or it did not, regardless of whether we could report it.
 */
export class SuperflowCallback {
  constructor(
    private readonly env: Env,
    private readonly repository: CallRepository,
    private readonly logger: Logger,
  ) {}

  get enabled(): boolean {
    return Boolean(this.env.SUPERFLOW_CALLBACK_URL);
  }

  async send(call: CallRecord): Promise<boolean> {
    const url = this.env.SUPERFLOW_CALLBACK_URL;
    if (!url) return false;

    // At-most-once: the first terminal webhook wins the claim, repeats get
    // false and return without sending, so SuperFlow never emails twice.
    if (!(await this.repository.claimPostCallCallback(call.id))) {
      this.logger.info(
        { event: "superflow_callback_skipped_duplicate", callId: call.id, twilioCallSid: call.twilio_call_sid },
        "post-call callback already sent for this call",
      );
      return false;
    }

    const log = this.logger.child({ callId: call.id, twilioCallSid: call.twilio_call_sid });
    const payload = buildCallbackPayload(call);
    let attemptNumber = 0;
    let deliveredStatus: number | null = null;

    try {
      deliveredStatus = await retry(
        async (attempt) => {
          attemptNumber = attempt;
          const status = await withTimeout(10_000, "superflow callback", async (signal) => {
            const response = await fetch(url, {
              method: "POST",
              signal,
              headers: {
                "content-type": "application/json",
                ...(this.env.SUPERFLOW_CALLBACK_SECRET
                  ? { authorization: `Bearer ${this.env.SUPERFLOW_CALLBACK_SECRET}` }
                  : {}),
              },
              body: JSON.stringify(payload),
            });
            if (!response.ok) {
              const error = new Error(`SuperFlow callback returned HTTP ${response.status}`) as Error & {
                statusCode: number;
              };
              error.statusCode = response.status;
              throw error;
            }
            return response.status;
          });

          await this.repository.recordCallbackAttempt(call.id, attempt, true, status, null);
          return status;
        },
        {
          attempts: 4,
          baseDelayMs: 500,
          maxDelayMs: 8000,
          isRetryable: isTransientHttpError,
          onRetry: (err, attempt) =>
            log.warn({ event: "superflow_callback_retry", attempt, err: String(err) }, "retrying callback"),
        },
      );

      log.info(
        { event: "superflow_callback_sent", status: call.status, httpStatus: deliveredStatus, ok: true },
        "callback delivered",
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = (err as { statusCode?: number }).statusCode ?? null;

      await this.repository
        .recordCallbackAttempt(call.id, attemptNumber || 1, false, statusCode, message)
        .catch(() => undefined);

      // Deliberately swallowed: call state is authoritative and stays as-is.
      log.error(
        { event: "superflow_callback_failed", httpStatus: statusCode, ok: false, err: message },
        "callback delivery failed",
      );
      return false;
    }
  }
}
