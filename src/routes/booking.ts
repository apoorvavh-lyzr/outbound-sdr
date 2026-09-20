import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { csvList, type Env } from "../config/env.js";
import { isValidTimeZone, type DemoBooker } from "../google/booking.js";
import { requireSuperflowAuth } from "./calls.js";
import { AppError, toAppError } from "../utils/errors.js";

const slotsSchema = z
  .object({
    from: z.string().datetime({ offset: true }).optional(),
    days: z.number().int().min(1).max(60).default(7),
    duration_minutes: z.number().int().min(15).max(180).optional(),
    limit: z.number().int().min(1).max(50).default(20),
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

/**
 * LLM tool callers sometimes fall back to generic calendar field names
 * (start_time, invitees, title…) despite the schema. Map the obvious ones
 * onto ours before validation so a booking is not lost to naming.
 */
export function normalizeBookingBody(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const b = { ...(raw as Record<string, unknown>) };
  const first = (v: unknown) => (Array.isArray(v) ? v[0] : v);
  const emailOf = (v: unknown): unknown => {
    const x = first(v);
    return x && typeof x === "object" ? (x as Record<string, unknown>).email : x;
  };
  b.lead_email ??=
    b.email ?? b.attendee_email ?? b.prospect_email ?? b.invitee_email ?? b.guest_email ??
    emailOf(b.invite) ?? emailOf(b.invitee) ?? emailOf(b.invitees) ?? emailOf(b.attendee) ?? emailOf(b.attendees) ?? emailOf(b.guests);
  b.lead_name ??= b.name ?? b.attendee_name ?? b.prospect_name ?? b.invitee_name ?? b.full_name;
  b.start ??= b.start_time ?? b.startTime ?? b.start_datetime ?? b.datetime ?? b.date_time ?? b.time;
  const end = b.end ?? b.end_time ?? b.endTime;
  b.duration_minutes ??= b.duration ?? b.length_minutes ?? b.duration_min;
  if (b.duration_minutes === undefined && typeof b.start === "string" && typeof end === "string") {
    const ms = Date.parse(end) - Date.parse(b.start);
    if (Number.isFinite(ms) && ms > 0) b.duration_minutes = Math.round(ms / 60000);
  }
  if (typeof b.duration_minutes === "string" && /^\d+$/.test(b.duration_minutes)) b.duration_minutes = Number(b.duration_minutes);
  b.notes ??= b.description ?? b.agenda ?? b.note;
  const ours = new Set(["lead_email", "lead_name", "company", "phone", "start", "duration_minutes", "notes", "host_emails"]);
  for (const k of Object.keys(b)) if (!ours.has(k)) delete b[k];
  return b;
}

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

    const parsed = bookSchema.safeParse(normalizeBookingBody(request.body));
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".") || "body";
      const why = issue?.message === "Required" ? "is required" : (issue?.message ?? "is invalid");
      return fail(
        reply,
        new AppError("invalid_request", `${field} ${why}. Expected fields: lead_email, start (ISO 8601 from findDemoSlots), and optionally lead_name, company, phone, duration_minutes, notes.`, 400),
      );
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
