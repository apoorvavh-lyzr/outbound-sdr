import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { DemoBookingChecker } from "../google/calendar.js";
import { requireSuperflowAuth } from "./calls.js";
import { impersonationDomain } from "../config/env.js";
import { AppError, toAppError } from "../utils/errors.js";

const requestSchema = z.object({
  lead_email: z.string().trim().toLowerCase().email("lead_email must be a valid address"),
  lead_name: z.string().trim().optional(),
  /** Assigned AE. Their calendar is checked alongside the shared one. */
  ae_email: z
    .string()
    .trim()
    .toLowerCase()
    .email("ae_email must be a valid address")
    .optional()
    .or(z.literal("").transform(() => undefined))
    .or(z.null().transform(() => undefined)),
});

export interface DemoCheckRoutesDeps {
  env: Env;
  /** Undefined when the Google variables are not configured. */
  checker: DemoBookingChecker | undefined;
}

/**
 * POST /check-demo-booking
 *
 * SuperFlow calls this before the outbound call. The response is designed so
 * a calendar failure can never be mistaken for "not booked":
 *   already_booked: true  | false  → success:true, HTTP 200
 *   already_booked: null           → success:false, HTTP 4xx/5xx
 * The IF node must branch on `already_booked == false`, never `!= true`.
 */
export function registerDemoCheckRoutes(app: FastifyInstance, deps: DemoCheckRoutesDeps): void {
  const { env, checker } = deps;

  const fail = (reply: FastifyReply, err: AppError, leadEmail: string | null) =>
    reply.status(err.statusCode).send({
      success: false,
      already_booked: null,
      lead_email: leadEmail,
      event: null,
      error: err.code,
      message: err.message,
    });

  app.post("/check-demo-booking", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      requireSuperflowAuth(request, env);
    } catch (err) {
      return fail(reply, toAppError(err), null);
    }

    const parsed = requestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return fail(reply, new AppError("invalid_request", "lead_email is required and must be a valid email", 400), null);
    }
    const { lead_email, ae_email } = parsed.data;

    if (ae_email && !ae_email.endsWith(`@${impersonationDomain(env)}`)) {
      return fail(
        reply,
        new AppError("invalid_request", `ae_email must be an @${impersonationDomain(env)} address`, 400),
        lead_email,
      );
    }

    if (!checker) {
      return fail(
        reply,
        new AppError("calendar_check_failed", "Google Calendar credentials are not configured on this service", 503),
        lead_email,
      );
    }

    try {
      const result = await checker.check(lead_email, ae_email);
      return reply.status(200).send({
        success: true,
        already_booked: result.alreadyBooked,
        lead_email,
        ae_email: ae_email ?? null,
        calendar_id: checker.calendarId,
        calendars_checked: result.calendarsChecked,
        event: result.event,
      });
    } catch (err) {
      return fail(reply, toAppError(err), lead_email);
    }
  });
}
