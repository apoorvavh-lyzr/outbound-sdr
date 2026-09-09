import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Env } from "../config/env.js";
import type { CallService } from "../calls/service.js";
import { leadSchema, sanitizeCall } from "../calls/types.js";
import type { TranscriptProvider } from "../lyzr/transcriptProvider.js";
import { safeEqual } from "../twilio/validation.js";
import { NotFoundError, UnauthorizedError, ValidationError } from "../utils/errors.js";

/** Bearer check against SUPERFLOW_SHARED_SECRET, in constant time. */
function requireSuperflowAuth(request: FastifyRequest, env: Env): void {
  const expected = env.SUPERFLOW_SHARED_SECRET;
  // With no secret configured, only mock mode may run unauthenticated.
  if (!expected) {
    if (env.MOCK_EXTERNAL_SERVICES) return;
    throw new UnauthorizedError("Service is not configured with SUPERFLOW_SHARED_SECRET");
  }

  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError("Missing bearer token");
  }
  if (!safeEqual(header.slice(7).trim(), expected)) {
    throw new UnauthorizedError("Invalid bearer token");
  }
}

export interface CallRoutesDeps {
  env: Env;
  service: CallService;
  transcripts: TranscriptProvider;
}

export function registerCallRoutes(app: FastifyInstance, deps: CallRoutesDeps): void {
  const { env, service, transcripts } = deps;

  app.post(
    "/api/call",
    {
      config: { rateLimit: { max: env.CALL_RATE_LIMIT_MAX, timeWindow: env.CALL_RATE_LIMIT_WINDOW_MS } },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      requireSuperflowAuth(request, env);

      const parsed = leadSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new ValidationError("Invalid lead payload", parsed.error.flatten());
      }

      const rawKey = request.headers["idempotency-key"];
      const idempotencyKey = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : null;

      const { call, replayed } = await service.placeCall(parsed.data, idempotencyKey);

      return reply.status(replayed ? 200 : 202).send({
        success: true,
        call_id: call.id,
        twilio_call_sid: call.twilio_call_sid,
        status: call.status,
        idempotent_replay: replayed,
      });
    },
  );

  app.get("/api/calls/:callId", async (request: FastifyRequest, reply: FastifyReply) => {
    requireSuperflowAuth(request, env);
    const { callId } = request.params as { callId: string };

    const call = await service.getCall(callId);
    if (!call) throw new NotFoundError(`Call ${callId} not found`);

    return reply.send(sanitizeCall(call));
  });

  app.get("/api/calls/:callId/transcript", async (request: FastifyRequest, reply: FastifyReply) => {
    requireSuperflowAuth(request, env);
    const { callId } = request.params as { callId: string };

    const call = await service.getCall(callId);
    if (!call) throw new NotFoundError(`Call ${callId} not found`);

    return reply.send(await transcripts.fetch(call.lyzr_session_id));
  });
}
