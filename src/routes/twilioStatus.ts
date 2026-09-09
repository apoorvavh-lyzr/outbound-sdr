import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";
import type { CallService } from "../calls/service.js";
import { mapTwilioStatus } from "../calls/stateMachine.js";
import { twilioStatusCallbackSchema } from "../twilio/schemas.js";
import { reconstructWebhookUrl, validateTwilioSignature } from "../twilio/validation.js";
import { UnauthorizedError } from "../utils/errors.js";

export const TWILIO_STATUS_PATH = "/api/twilio/status";

export function registerTwilioStatusRoute(app: FastifyInstance, env: Env, service: CallService): void {
  app.post(TWILIO_STATUS_PATH, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;

    // Signature validation is skipped only when explicitly disabled or when no
    // auth token exists (mock mode) - never silently.
    if (env.TWILIO_VALIDATE_WEBHOOKS && env.TWILIO_AUTH_TOKEN) {
      const signature = request.headers["x-twilio-signature"];
      const url = reconstructWebhookUrl(
        env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`,
        TWILIO_STATUS_PATH,
      );

      const valid = validateTwilioSignature({
        authToken: env.TWILIO_AUTH_TOKEN,
        signature: typeof signature === "string" ? signature : undefined,
        url,
        params: body,
      });

      if (!valid) {
        request.log.warn({ event: "twilio_signature_invalid" }, "rejected unsigned Twilio status callback");
        throw new UnauthorizedError("Invalid Twilio signature");
      }
    }

    const parsed = twilioStatusCallbackSchema.safeParse(body);
    if (!parsed.success) {
      // Acknowledge malformed callbacks so Twilio stops retrying them.
      request.log.warn({ event: "twilio_status_malformed" }, "ignoring malformed status callback");
      return reply.status(204).send();
    }

    const internalStatus = mapTwilioStatus(parsed.data.CallStatus);
    if (internalStatus) {
      await service.applyTwilioStatus(parsed.data.CallSid, internalStatus, parsed.data);
    }

    return reply.status(204).send();
  });
}
