import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Logger } from "pino";
import type { Env } from "./config/env.js";
import { createDatabase, type Database } from "./db/client.js";
import { CallRepository } from "./db/repository.js";
import { CallService } from "./calls/service.js";
import { LyzrClient } from "./lyzr/client.js";
import { ClonedAgentCleanup } from "./lyzr/cleanup.js";
import { selectContextStrategy, type AgentContextStrategy } from "./lyzr/contextStrategy.js";
import { MockContextStrategy } from "./lyzr/mock.js";
import { createTranscriptProvider } from "./lyzr/transcriptProvider.js";
import { MockTwilioClient, RealTwilioClient, type TwilioCallClient } from "./twilio/client.js";
import { SuperflowCallback } from "./callback/superflow.js";
import { registerCallRoutes } from "./routes/calls.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerTwilioStatusRoute } from "./routes/twilioStatus.js";
import { AppError, toAppError } from "./utils/errors.js";
import { getLogger } from "./utils/logging.js";

export interface BuiltApp {
  app: FastifyInstance;
  db: Database;
  repository: CallRepository;
  service: CallService;
  lyzr: LyzrClient;
  cleanup: ClonedAgentCleanup;
  env: Env;
  logger: Logger;
}

export interface BuildAppOptions {
  env: Env;
  /** Overrides for tests. */
  database?: Database;
  twilioClient?: TwilioCallClient;
  strategy?: AgentContextStrategy;
  logger?: Logger;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { env } = options;
  const logger = options.logger ?? getLogger();

  if (env.MOCK_EXTERNAL_SERVICES) {
    logger.warn({ event: "mock_mode_active" }, "MOCK_EXTERNAL_SERVICES is enabled - no real calls will be placed");
  }

  const db = options.database ?? createDatabase(env.DATABASE_URL);
  await db.migrate();

  const repository = new CallRepository(db);

  const lyzr = new LyzrClient({
    apiKey: env.LYZR_API_KEY ?? "",
    voiceApiBase: env.LYZR_VOICE_API_BASE,
    timeoutMs: env.LYZR_HTTP_TIMEOUT_MS,
    sessionTimeoutMs: env.LYZR_SESSION_TIMEOUT_MS,
  });

  const strategy =
    options.strategy ??
    (env.MOCK_EXTERNAL_SERVICES
      ? new MockContextStrategy()
      : selectContextStrategy(lyzr, env.LYZR_ENABLE_AGENT_CLONING));

  const twilioClient =
    options.twilioClient ??
    (env.MOCK_EXTERNAL_SERVICES
      ? new MockTwilioClient()
      : new RealTwilioClient(env.TWILIO_ACCOUNT_SID!, env.TWILIO_AUTH_TOKEN!));

  const callback = new SuperflowCallback(env, repository, logger);

  const service = new CallService({
    env,
    repository,
    strategy,
    twilio: twilioClient,
    logger,
    onTerminal: (call) => {
      // Fire-and-forget: delivery problems must never change call state.
      if (callback.enabled) void callback.send(call);
    },
  });

  const app: FastifyInstance = Fastify({
    // Widened to FastifyBaseLogger: passing the concrete pino type would
    // narrow FastifyInstance's logger generic and break route registration.
    loggerInstance: logger as FastifyBaseLogger,
    // Railway terminates TLS upstream; trust its forwarded headers so rate
    // limiting keys on the real client IP.
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(formbody); // Twilio status callbacks are form-encoded
  await app.register(rateLimit, {
    global: false,
    max: env.CALL_RATE_LIMIT_MAX,
    timeWindow: env.CALL_RATE_LIMIT_WINDOW_MS,
  });

  app.setErrorHandler((error, request, reply) => {
    const appError: AppError = error instanceof AppError ? error : toAppError(error);
    const status = appError.statusCode;

    if (status >= 500) {
      request.log.error({ event: "request_failed", code: appError.code }, appError.message);
    } else {
      request.log.warn({ event: "request_rejected", code: appError.code }, appError.message);
    }

    return reply.status(status).send(appError.toJSON());
  });

  const cleanup = new ClonedAgentCleanup(
    repository,
    lyzr,
    env.CLONED_AGENT_RETENTION_HOURS,
    logger,
    env.LYZR_BASE_AGENT_ID,
  );

  registerHealthRoutes(app, env, db);
  registerCallRoutes(app, { env, service, transcripts: createTranscriptProvider(env) });
  registerTwilioStatusRoute(app, env, service);

  return { app, db, repository, service, lyzr, cleanup, env, logger };
}
