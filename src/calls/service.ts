import type { Logger } from "pino";
import type { Env } from "../config/env.js";
import { mediaStreamUrl } from "../config/env.js";
import { CallRepository, isUniqueViolation } from "../db/repository.js";
import type { AgentContextStrategy } from "../lyzr/contextStrategy.js";
import type { TwilioCallClient } from "../twilio/client.js";
import { buildStreamTwiML } from "../twilio/twiml.js";
import { signStreamToken } from "../twilio/validation.js";
import { AppError, PreflightError, toAppError } from "../utils/errors.js";
import { maskEmail, maskPhone } from "../utils/logging.js";
import { resolveTransition } from "./stateMachine.js";
import { isTerminal, type CallRecord, type CallStatus, type Lead } from "./types.js";

export interface SuppressionCheck {
  /** Returns a reason to suppress, or null to allow the call. */
  (lead: Lead): Promise<string | null>;
}

export interface CallServiceDeps {
  env: Env;
  repository: CallRepository;
  strategy: AgentContextStrategy;
  twilio: TwilioCallClient;
  logger: Logger;
  suppressionCheck?: SuppressionCheck;
  onTerminal?: (call: CallRecord) => void;
}

export interface PlaceCallResult {
  call: CallRecord;
  replayed: boolean;
}

export class CallService {
  constructor(private readonly deps: CallServiceDeps) {}

  private get log() {
    return this.deps.logger;
  }

  /**
   * Validates, prepares the Lyzr agent, then dials.
   *
   * Ordering is deliberate: nothing is dialled until the per-call agent exists
   * and its calendar tooling is verified. A prospect must never be phoned by an
   * agent that cannot actually book them in.
   */
  async placeCall(lead: Lead, idempotencyKey: string | null): Promise<PlaceCallResult> {
    const { env, repository } = this.deps;

    if (idempotencyKey) {
      const existing = await repository.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        this.log.info(
          { event: "call_idempotent_replay", callId: existing.id, idempotencyKey },
          "returning existing call for repeated Idempotency-Key",
        );
        return { call: existing, replayed: true };
      }
    }

    if (env.ENABLE_DNC_CHECK && this.deps.suppressionCheck) {
      const reason = await this.deps.suppressionCheck(lead);
      if (reason) {
        throw new PreflightError("suppressed", `Call suppressed: ${reason}`);
      }
    }

    let call: CallRecord;
    try {
      call = await repository.create(lead, idempotencyKey, env.LYZR_BASE_AGENT_ID ?? null);
    } catch (err) {
      // Lost a race against a concurrent request with the same key.
      if (idempotencyKey && isUniqueViolation(err)) {
        const winner = await repository.findByIdempotencyKey(idempotencyKey);
        if (winner) return { call: winner, replayed: true };
      }
      throw err;
    }

    const log = this.log.child({ callId: call.id });
    log.info(
      {
        event: "call_request_received",
        call_mode: lead.call_mode,
        phone: maskPhone(lead.phone),
        email: maskEmail(lead.email),
      },
      "accepted call request",
    );

    try {
      call = await this.prepareAndDial(call, lead, log);
      return { call, replayed: false };
    } catch (err) {
      const appError = toAppError(err);
      const failed = await this.deps.repository.update(call.id, {
        status: "failed",
        error_code: appError.code,
        error_message: appError.message,
        completed_at: new Date().toISOString(),
      });
      log.error({ event: "call_failed", code: appError.code }, appError.message);
      this.deps.onTerminal?.(failed);
      throw appError;
    }
  }

  private async prepareAndDial(call: CallRecord, lead: Lead, log: Logger): Promise<CallRecord> {
    const { env, repository, strategy, twilio } = this.deps;

    await repository.update(call.id, { status: "agent_preparing" });

    const baseAgentId = env.LYZR_BASE_AGENT_ID;
    if (!baseAgentId) {
      throw new PreflightError("missing_base_agent", "LYZR_BASE_AGENT_ID is not configured");
    }

    const prepared = await strategy.prepareCallAgent(baseAgentId, lead, call.id);
    log.info(
      { event: "calendar_tools_verified", agentId: prepared.agentId, strategy: prepared.strategy },
      "per-call agent ready with required calendar tools",
    );

    await repository.update(call.id, {
      status: "agent_prepared",
      lyzr_call_agent_id: prepared.agentId,
      metadata: { strategy: prepared.strategy, cloned: prepared.cloned, removedFields: prepared.removedFields },
    });

    // Final pre-dial gate.
    this.assertDialable(call, env);

    const streamUrl = mediaStreamUrl(env);
    const twiml = buildStreamTwiML({
      streamUrl,
      callId: call.id,
      parameters: { token: signStreamToken(call.id, this.streamSecret()) },
    });

    const created = await twilio.createCall({
      to: lead.phone,
      from: env.TWILIO_PHONE_NUMBER!,
      twiml,
      statusCallbackUrl: `${env.PUBLIC_BASE_URL!.replace(/\/+$/, "")}/api/twilio/status`,
      timeoutSeconds: env.TWILIO_CALL_TIMEOUT_SECONDS,
    });

    log.info({ event: "twilio_call_created", twilioCallSid: created.sid }, "outbound call queued");

    return repository.update(call.id, { status: "queued", twilio_call_sid: created.sid });
  }

  /** Secret used to authenticate the Media Stream upgrade. */
  private streamSecret(): string {
    const { env } = this.deps;
    return env.SUPERFLOW_SHARED_SECRET ?? env.TWILIO_AUTH_TOKEN ?? "insecure-development-secret";
  }

  private assertDialable(call: CallRecord, env: Env): void {
    if (!env.TWILIO_PHONE_NUMBER) {
      throw new PreflightError("missing_from_number", "TWILIO_PHONE_NUMBER is not configured");
    }
    if (!env.PUBLIC_BASE_URL) {
      throw new PreflightError("missing_public_base_url", "PUBLIC_BASE_URL is not configured");
    }
    // In production the stream URL must be wss://, which requires https://.
    if (env.NODE_ENV === "production" && !env.PUBLIC_BASE_URL.startsWith("https://")) {
      throw new PreflightError(
        "insecure_public_base_url",
        "PUBLIC_BASE_URL must be https:// so the Twilio Stream URL is wss://",
      );
    }
    if (!call.id) {
      throw new PreflightError("missing_call_record", "Call record was not persisted");
    }
  }

  /** Applies a Twilio status transition, ignoring late or duplicate webhooks. */
  async applyTwilioStatus(
    callSid: string,
    twilioStatus: CallStatus,
    raw: Record<string, unknown>,
  ): Promise<CallRecord | null> {
    const call = await this.deps.repository.findByTwilioCallSid(callSid);
    if (!call) return null;

    const next = resolveTransition(call.status, twilioStatus);
    const timestamp = new Date().toISOString();

    const patch: Parameters<CallRepository["update"]>[1] = { raw_twilio_status: raw };
    if (next !== call.status) {
      patch.status = next;
      if (next === "answered" && !call.answered_at) patch.answered_at = timestamp;
      if (isTerminal(next)) patch.completed_at = timestamp;
    }

    const errorCode = raw.ErrorCode;
    if (errorCode && !call.error_code) {
      patch.error_code = `twilio_${errorCode}`;
      patch.error_message = raw.ErrorMessage ? String(raw.ErrorMessage) : `Twilio error ${errorCode}`;
    }

    const updated = await this.deps.repository.update(call.id, patch);

    this.log.info(
      { event: "twilio_status_updated", callId: call.id, twilioCallSid: callSid, from: call.status, to: updated.status },
      "twilio status applied",
    );

    if (next !== call.status && isTerminal(next)) {
      this.deps.onTerminal?.(updated);
    }
    return updated;
  }

  /** Moves a call forward from the media-stream side of the bridge. */
  async markStreamStatus(callId: string, status: CallStatus): Promise<CallRecord | null> {
    const call = await this.deps.repository.findById(callId);
    if (!call) return null;

    const next = resolveTransition(call.status, status);
    if (next === call.status) return call;

    // Audio flowing means the prospect answered, even if Twilio's "answered"
    // webhook has not arrived yet.
    const patch: Parameters<CallRepository["update"]>[1] = { status: next };
    if (!call.answered_at) patch.answered_at = new Date().toISOString();

    return this.deps.repository.update(callId, patch);
  }

  async recordBridgeFailure(callId: string, error: AppError): Promise<void> {
    const call = await this.deps.repository.findById(callId);
    if (!call || isTerminal(call.status)) return;
    await this.deps.repository.update(callId, {
      error_code: error.code,
      error_message: error.message,
    });
  }

  getCall(callId: string): Promise<CallRecord | null> {
    return this.deps.repository.findById(callId);
  }
}
