import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { ConflictError, UpstreamError } from "../utils/errors.js";
import {
  CALENDAR_API,
  DemoBookingChecker,
  SCOPE_CALENDAR,
  eventOwner,
  eventTime,
  googleJson,
  meetLink,
  type FetchLike,
  type GoogleEvent,
  type MatchedEvent,
} from "./calendar.js";

/**
 * Writes demo bookings onto the shared calendar with the same service account
 * the pre-call check reads with. Replaces the agent's Composio calendar
 * actions, which cannot be OAuth-connected to the shared mailbox.
 */

export interface BookingConfig {
  calendarId: string;
  /** IANA zone the business hours are expressed in. */
  timezone: string;
  /** Local hour (0-23) demos may start from / must end by. */
  hoursStart: number;
  hoursEnd: number;
  /** 0=Sun … 6=Sat. */
  workingDays: number[];
  slotMinutes: number;
  /** Earliest a slot may start, relative to now. */
  minNoticeMinutes: number;
  timeoutMs: number;
}

/** The lead's side of the overlap: only slots inside their local daytime are offered. */
export interface LeadWindow {
  timezone: string;
  hoursStart: number;
  hoursEnd: number;
}

export interface SlotQuery {
  from?: Date;
  days: number;
  durationMinutes?: number;
  limit: number;
  lead?: LeadWindow;
}

export interface Slot {
  start: string;
  end: string;
  /** Present when a lead timezone was given: human-readable, in that zone. */
  start_local?: string;
  end_local?: string;
}

export interface BookingRequest {
  leadEmail: string;
  leadName?: string;
  company?: string;
  phone?: string;
  start: Date;
  durationMinutes: number;
  notes?: string;
  /** Extra Lyzr attendees, e.g. the AE who runs the demo. */
  hostEmails?: string[];
}

export type BookedEvent = MatchedEvent;

export interface BookingResult {
  /** True when the lead already had an upcoming demo and no new event was created. */
  alreadyBooked: boolean;
  event: BookedEvent;
}

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
}

interface Interval {
  start: number;
  end: number;
}

const MINUTE = 60_000;

/** Wall-clock parts of `date` in `timeZone`. */
function zonedParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
  });
  const get = (type: string) => fmt.formatToParts(date).find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** e.g. "Tue, 22 Sep 2026, 10:00 EDT" — what the agent reads out to the lead. */
export function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).format(date);
}

/** Minutes since local midnight of `date` in `timeZone`. */
function localMinutes(date: Date, timeZone: string): number {
  const p = zonedParts(date, timeZone);
  return p.hour * 60 + p.minute;
}

/** UTC instant for a wall-clock time in `timeZone`. Handles DST via one correction pass. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const parts = zonedParts(new Date(guess), timeZone);
  const seen = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return new Date(guess - (seen - guess));
}

/**
 * Pure slot generator, exported for tests: walks each working day's business
 * hours in `slotMinutes` steps and drops anything overlapping a busy interval,
 * starting before `earliest`, or shorter than `durationMinutes`. With a
 * `lead` window the slot must ALSO sit inside the lead's local daytime
 * (start at or after hoursStart, end at or before hoursEnd, same local day).
 */
export function computeFreeSlots(
  config: BookingConfig,
  busy: Interval[],
  from: Date,
  days: number,
  durationMinutes: number,
  earliest: Date,
  limit: number,
  lead?: LeadWindow,
): Slot[] {
  const slots: Slot[] = [];
  const stepMs = config.slotMinutes * MINUTE;
  const durMs = durationMinutes * MINUTE;
  const overlaps = (s: number, e: number) => busy.some((b) => s < b.end && e > b.start);
  const inLeadDaytime = (s: number, e: number) => {
    if (!lead) return true;
    const startMin = localMinutes(new Date(s), lead.timezone);
    // End is exclusive; a slot ending exactly at hoursEnd (e.g. 17:30–18:00) is fine.
    const endMin = localMinutes(new Date(e - 1), lead.timezone) + 1;
    return startMin >= lead.hoursStart * 60 && endMin <= lead.hoursEnd * 60 && endMin > startMin;
  };

  // Iterate by local calendar day so DST changes do not skip or double a day.
  const first = zonedParts(from, config.timezone);
  for (let i = 0; i < days && slots.length < limit; i++) {
    const dayStart = zonedTimeToUtc(first.year, first.month, first.day + i, config.hoursStart, 0, config.timezone);
    if (!config.workingDays.includes(zonedParts(dayStart, config.timezone).weekday)) continue;
    const dayEnd = zonedTimeToUtc(first.year, first.month, first.day + i, config.hoursEnd, 0, config.timezone);

    for (let s = dayStart.getTime(); s + durMs <= dayEnd.getTime() && slots.length < limit; s += stepMs) {
      const e = s + durMs;
      if (s < earliest.getTime()) continue;
      if (overlaps(s, e)) continue;
      if (!inLeadDaytime(s, e)) continue;
      const slot: Slot = { start: new Date(s).toISOString(), end: new Date(e).toISOString() };
      if (lead) {
        slot.start_local = formatLocal(new Date(s), lead.timezone);
        slot.end_local = formatLocal(new Date(e), lead.timezone);
      }
      slots.push(slot);
    }
  }
  return slots;
}

export class DemoBooker {
  constructor(
    private readonly checker: DemoBookingChecker,
    private readonly config: BookingConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = checker.fetchImpl,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get calendarId(): string {
    return this.config.calendarId;
  }

  get timezone(): string {
    return this.config.timezone;
  }

  private withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    return run(controller.signal).finally(() => clearTimeout(timer));
  }

  private async freeBusy(token: string, from: Date, to: Date, signal: AbortSignal): Promise<Interval[]> {
    const json = await googleJson<FreeBusyResponse>(
      this.fetchImpl,
      `${CALENDAR_API}/freeBusy`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          timeMin: from.toISOString(),
          timeMax: to.toISOString(),
          timeZone: "UTC",
          items: [{ id: this.config.calendarId }],
        }),
        signal,
      },
      "freebusy.query",
      "slot_lookup_failed",
    );
    const cal = json.calendars?.[this.config.calendarId];
    if (!cal || (cal.errors && cal.errors.length > 0)) {
      throw new UpstreamError("slot_lookup_failed", "Google could not read the demo calendar's availability", 502, {
        stage: "freebusy.query",
        errors: cal?.errors,
      });
    }
    return (cal.busy ?? []).map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) }));
  }

  /** Open demo slots on the shared calendar. Never falls back to "everything is free". */
  async availableSlots(query: SlotQuery): Promise<Slot[]> {
    const now = this.now();
    const from = query.from ?? now;
    const duration = query.durationMinutes ?? this.config.slotMinutes;
    const to = new Date(from.getTime() + query.days * 24 * 60 * MINUTE);
    const earliest = new Date(now.getTime() + this.config.minNoticeMinutes * MINUTE);

    return this.withTimeout(async (signal) => {
      const token = await this.checker.auth.getAccessToken(SCOPE_CALENDAR, signal);
      const busy = await this.freeBusy(token, from, to, signal);
      const slots = computeFreeSlots(this.config, busy, from, query.days, duration, earliest, query.limit, query.lead);
      this.logger.info(
        {
          event: "demo_slots",
          calendar_id: this.config.calendarId,
          from: from.toISOString(),
          days: query.days,
          lead_timezone: query.lead?.timezone ?? null,
          returned: slots.length,
        },
        "computed available demo slots",
      );
      return slots;
    });
  }

  /**
   * Books the lead. Idempotent per lead: if they already have an upcoming
   * non-declined demo, that event is returned and nothing new is created.
   * Refuses with 409 slot_taken if the calendar is busy at the requested time.
   */
  async book(req: BookingRequest): Promise<BookingResult> {
    const leadEmail = req.leadEmail.trim().toLowerCase();
    const start = req.start;
    const end = new Date(start.getTime() + req.durationMinutes * MINUTE);

    if (Number.isNaN(start.getTime())) {
      throw new ConflictError("start is not a valid timestamp");
    }
    if (start.getTime() < this.now().getTime() + this.config.minNoticeMinutes * MINUTE) {
      throw new UpstreamError("slot_in_past", "Requested start is too soon or in the past", 409);
    }

    // The check throws (never returns "unknown") on any calendar failure.
    const existing = await this.checker.check(leadEmail);
    if (existing.alreadyBooked && existing.event) {
      this.logger.info(
        { event: "demo_book_idempotent", lead_email: leadEmail, matched_event_id: existing.event.id },
        "lead already booked; returning existing event",
      );
      return { alreadyBooked: true, event: existing.event };
    }

    return this.withTimeout(async (signal) => {
      const token = await this.checker.auth.getAccessToken(SCOPE_CALENDAR, signal);

      const busy = await this.freeBusy(token, start, end, signal);
      if (busy.some((b) => start.getTime() < b.end && end.getTime() > b.start)) {
        throw new UpstreamError("slot_taken", "The demo calendar is busy at the requested time", 409);
      }

      const attendees = [
        { email: leadEmail, displayName: req.leadName },
        ...(req.hostEmails ?? []).map((email) => ({ email })),
      ];
      const who = req.leadName ?? leadEmail;
      const description = [
        `Lyzr demo with ${who}${req.company ? ` (${req.company})` : ""}.`,
        req.phone ? `Phone: ${req.phone}` : null,
        req.notes ? `\nNotes:\n${req.notes}` : null,
        "\nBooked by the Lyzr voice agent.",
      ]
        .filter(Boolean)
        .join("\n");

      const url =
        `${CALENDAR_API}/calendars/${encodeURIComponent(this.config.calendarId)}/events` +
        `?conferenceDataVersion=1&sendUpdates=all`;
      const created = await googleJson<GoogleEvent>(
        this.fetchImpl,
        url,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            summary: `Lyzr Demo – ${req.company ? `${req.company} / ` : ""}${who}`,
            description,
            start: { dateTime: start.toISOString(), timeZone: "UTC" },
            end: { dateTime: end.toISOString(), timeZone: "UTC" },
            attendees,
            guestsCanSeeOtherGuests: false,
            conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } },
            reminders: { useDefault: true },
            extendedProperties: { private: { lyzr_lead_email: leadEmail, lyzr_source: "outbound-voice" } },
          }),
          signal,
        },
        "events.insert",
        "booking_failed",
      );

      const event: BookedEvent = {
        id: created.id ?? "",
        summary: created.summary ?? null,
        start: eventTime(created.start),
        end: eventTime(created.end),
        html_link: created.htmlLink ?? null,
        meet_link: meetLink(created),
        owner: eventOwner(created, this.config.calendarId, leadEmail),
      };
      this.logger.info(
        { event: "demo_booked", lead_email: leadEmail, calendar_id: this.config.calendarId, event_id: event.id, start: event.start, end: event.end },
        "demo booked on shared calendar",
      );
      return { alreadyBooked: false, event };
    });
  }
}
