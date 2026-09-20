import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { csvList, type Env } from "../config/env.js";
import { isValidTimeZone, type DemoBooker } from "../google/booking.js";
import { requireSuperflowAuth } from "./calls.js";
import { AppError, toAppError } from "../utils/errors.js";

const slotsSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    days: z.number().int().min(1).max(60).default(14),
    duration_minutes: z.number().int().min(15).max(180).optional(),
    limit: z.number().int().min(1).max(50).default(8),
    /** Lead's IANA zone. When given, only slots inside their local daytime are returned. */
    timezone: z
      .string()
      .trim()
      .refine(isValidTimeZone, "timezone must be a valid IANA zone, e.g. America/New_York")
      .optional(),
    lead_hours_start: z.number().int().min(0).max(23).default(9),
    lead_hours_end: z.number().int().min(1).max(24).default(18),
  })
  .refine((q) => q.lead_hours_end > q.lead_hours_start, {
    message: "lead_hours_end must be after lead_hours_start",
    path: ["lead_hours_end"],
  });

const bookSchema = z.object({
  lead_email: z.string().trim().toLowerCase().email("lead_email must be a valid address"),
  lead_name: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  start: z.string().datetime({ offset: true }),
  duration_minutes: z.number().int().min(15).max(180).optional(),
  notes: z.string().trim().max(4000).optional(),
  host_emails: z.array(z.string().trim().toLowerCase().email()).max(5).optional(),
});

export interface BookingRoutesDeps {
  env: Env;
  booker: DemoBooker | undefined;
}

/**
 * POST /demo-slots and POST /book-demo - the two HTTP tools the voice agent
 * calls instead of Composio's GOOGLECALENDAR_* actions. Same bearer secret as
 * /api/call. Errors carry `success:false` plus a stable `error` code so the
 * agent can tell the prospect what happened rather than guessing.
 */
export function registerBookingRoutes(app: FastifyInstance, deps: BookingRoutesDeps): void {
  const { env, booker } = deps;

  const fail = (reply: FastifyReply, err: AppError) =>
    reply.status(err.statusCode).send({ success: false, error: err.code, message: err.message });

  const guard = (request: FastifyRequest, reply: FastifyReply): DemoBooker | undefined => {
    try {
      requireSuperflowAuth(request, env);
    } catch (err) {
      void fail(reply, toAppError(err));
      return undefined;
    }
    if (!booker) {
      void fail(reply, new AppError("booking_unavailable", "Google Calendar credentials are not configured on this service", 503));
      return undefined;
    }
    return booker;
  };

  app.post("/demo-slots", async (request, reply) => {
    const b = guard(request, reply);
    if (!b) return reply;

    const parsed = slotsSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return fail(reply, new AppError("invalid_request", parsed.error.issues[0]?.message ?? "invalid request", 400));
    }
    const q = parsed.data;
    try {
      const lead = q.timezone
        ? { timezone: q.timezone, hoursStart: q.lead_hours_start, hoursEnd: q.lead_hours_end }
        : undefined;
      const slots = await b.availableSlots({
        from: q.from ? new Date(q.from) : undefined,
        days: q.days,
        durationMinutes: q.duration_minutes,
        limit: q.limit,
        lead,
      });
      return reply.send({
        success: true,
        calendar_id: b.calendarId,
        timezone: b.timezone,
        lead_timezone: lead?.timezone ?? null,
        slots,
      });
    } catch (err) {
      return fail(reply, toAppError(err));
    }
  });

  app.post("/book-demo", async (request, reply) => {
    const b = guard(request, reply);
    if (!b) return reply;

    const parsed = bookSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return fail(reply, new AppError("invalid_request", parsed.error.issues[0]?.message ?? "invalid request", 400));
    }
    const r = parsed.data;
    try {
      const result = await b.book({
        leadEmail: r.lead_email,
        leadName: r.lead_name,
        company: r.company,
        phone: r.phone,
        start: new Date(r.start),
        durationMinutes: r.duration_minutes ?? env.DEMO_SLOT_MINUTES,
        notes: r.notes,
        hostEmails: r.host_emails ?? csvList(env.DEMO_HOST_EMAILS),
      });
      return reply.status(result.alreadyBooked ? 200 : 201).send({
        success: true,
        already_booked: result.alreadyBooked,
        lead_email: r.lead_email,
        calendar_id: b.calendarId,
        event: result.event,
      });
    } catch (err) {
      return fail(reply, toAppError(err));
    }
  });
}
