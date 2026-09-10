import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client.js";
import type { Env } from "../config/env.js";

export function registerHealthRoutes(app: FastifyInstance, env: Env, db: Database): void {
  // Railway injects RAILWAY_GIT_COMMIT_SHA at build time. Surfacing it makes
  // "is my push actually live?" answerable with one request instead of
  // inferring it from which routes happen to 404.
  const commit = process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? "unknown";

  app.get("/health", async () => ({ ok: true, service: "lyzr-outbound-voice", commit }));

  /**
   * Readiness: configuration plus a real database round-trip.
   * Never places an external call - Railway probes this frequently.
   */
  app.get("/ready", async (_request, reply) => {
    const checks: Record<string, boolean> = {
      public_base_url: Boolean(env.PUBLIC_BASE_URL) || env.MOCK_EXTERNAL_SERVICES,
      lyzr_configured: Boolean(env.LYZR_API_KEY && env.LYZR_BASE_AGENT_ID) || env.MOCK_EXTERNAL_SERVICES,
      twilio_configured:
        Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER) ||
        env.MOCK_EXTERNAL_SERVICES,
      superflow_secret: Boolean(env.SUPERFLOW_SHARED_SECRET) || env.MOCK_EXTERNAL_SERVICES,
      database: false,
    };

    try {
      await db.ping();
      checks.database = true;
    } catch {
      checks.database = false;
    }

    const ready = Object.values(checks).every(Boolean);
    return reply.status(ready ? 200 : 503).send({
      ready,
      checks,
      mock_mode: env.MOCK_EXTERNAL_SERVICES,
    });
  });
}
