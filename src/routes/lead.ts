import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { UpstreamError, ValidationError } from "../utils/errors.js";
import { maskEmail, maskPhone } from "../utils/logging.js";
import { withTimeout } from "../utils/timeout.js";
import { DEMO_PAGE_HTML } from "../web/demoPage.js";

const required = (label: string) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a string` })
    .trim()
    .min(1, `${label} is required`);

/**
 * Intake validation for the demo form. Intentionally separate from `leadSchema`
 * in calls/types.ts: that one describes what SuperFlow sends to /api/call after
 * its calendar logic has run, and carries meeting fields the form cannot know.
 */
export const intakeLeadSchema = z.object({
  first_name: required("first_name"),
  last_name: z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => (v === undefined || v === null ? "" : v.trim())),
  email: required("email").email("email must be a valid address").toLowerCase(),
  phone: required("phone").regex(
    /^\+[1-9]\d{6,14}$/,
    "phone must be in international format beginning with +, e.g. +919876543210",
  ),
  company: required("company"),
  use_case: required("use_case"),
  timezone: z
    .union([z.string(), z.null(), z.undefined()])
    // Mock version: no IANA database lookup, just a sane default.
    .transform((v) => (v === undefined || v === null || v.trim() === "" ? "Asia/Kolkata" : v.trim())),
});

export type IntakeLead = z.infer<typeof intakeLeadSchema>;

/** Exactly the JSON forwarded to the SuperFlow intake webhook. */
export function buildIntakePayload(lead: IntakeLead, submissionId: string) {
  return {
    submission_id: submissionId,
    first_name: lead.first_name,
    last_name: lead.last_name,
    email: lead.email,
    phone: lead.phone,
    company: lead.company,
    use_case: lead.use_case,
    timezone: lead.timezone,
  };
}

export interface LeadRoutesDeps {
  env: Env;
}

export function registerLeadRoutes(app: FastifyInstance, deps: LeadRoutesDeps): void {
  const { env } = deps;

  app.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.type("text/html; charset=utf-8").send(DEMO_PAGE_HTML);
  });

  app.post(
    "/api/lead",
    {
      // Reuses the existing rate-limit plugin. The form is a small JSON body,
      // so the global 1MB limit is tightened well below it here.
      config: { rateLimit: { max: env.CALL_RATE_LIMIT_MAX, timeWindow: env.CALL_RATE_LIMIT_WINDOW_MS } },
      bodyLimit: 16 * 1024,
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = intakeLeadSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw new ValidationError("Invalid lead payload", parsed.error.flatten());
      }

      const webhookUrl = env.SUPERFLOW_INTAKE_WEBHOOK_URL;
      if (!webhookUrl) {
        // Production cannot reach here - env validation requires the URL.
        request.log.error(
          { event: "lead_intake_not_configured" },
          "SUPERFLOW_INTAKE_WEBHOOK_URL is not configured",
        );
        throw new UpstreamError("intake_not_configured", "Lead intake is not configured");
      }

      // Server-side id: the browser never supplies it, so a double submission
      // is distinguishable downstream and every attempt is traceable in logs.
      const submissionId = randomUUID();
      const log = request.log.child({
        submissionId,
        email: maskEmail(parsed.data.email),
        phone: maskPhone(parsed.data.phone),
      });

      let status: number;
      try {
        status = await withTimeout(10_000, "superflow intake", async (signal) => {
          const response = await fetch(webhookUrl, {
            method: "POST",
            signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(buildIntakePayload(parsed.data, submissionId)),
          });
          return response.status;
        });
      } catch (err) {
        // The URL itself is never logged: it is a secret-bearing endpoint.
        log.error(
          { event: "lead_intake_failed", err: err instanceof Error ? err.message : String(err) },
          "lead intake forwarding failed",
        );
        throw new UpstreamError("intake_failed", "Could not submit your details. Please try again.");
      }

      if (status < 200 || status >= 300) {
        log.error({ event: "lead_intake_rejected", httpStatus: status }, "lead intake returned an error");
        throw new UpstreamError("intake_failed", "Could not submit your details. Please try again.");
      }

      log.info({ event: "lead_intake_forwarded", httpStatus: status }, "lead forwarded to intake");

      return reply.status(200).send({
        success: true,
        message: "Thanks — we'll follow up shortly.",
        submission_id: submissionId,
      });
    },
  );
}
