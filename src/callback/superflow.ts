import type { Logger } from "pino";
import type { Env } from "../config/env.js";
import type { CallRepository } from "../db/repository.js";
import { isTransientHttpError, retry } from "../utils/retry.js";
import { withTimeout } from "../utils/timeout.js";
import type { CallRecord } from "../calls/types.js";

/** Payload posted to SuperFlow when a call reaches a terminal status. */
export function buildCallbackPayload(call: CallRecord) {
  return {
    call_id: call.id,
    twilio_call_sid: call.twilio_call_sid,
    status: call.status,
    call_mode: call.call_mode,
    phone: call.phone,
    email: call.email,
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

    const log = this.logger.child({ callId: call.id });
    const payload = buildCallbackPayload(call);
    let attemptNumber = 0;

    try {
      await retry(
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

      log.info({ event: "superflow_callback_sent", status: call.status }, "callback delivered");
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const statusCode = (err as { statusCode?: number }).statusCode ?? null;

      await this.repository
        .recordCallbackAttempt(call.id, attemptNumber || 1, false, statusCode, message)
        .catch(() => undefined);

      // Deliberately swallowed: call state is authoritative and stays as-is.
      log.error({ event: "superflow_callback_failed", err: message }, "callback delivery failed");
      return false;
    }
  }
}
