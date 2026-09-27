import type { Logger } from "pino";
import type { Env } from "../config/env.js";
import type { CallRepository } from "../db/repository.js";
import {
  SCOPE_CALENDAR,
  CALENDAR_API,
  eventOwner,
  eventTime,
  googleJson,
  meetLink,
  type DemoBookingChecker,
  type GoogleAttendee,
  type GoogleEvent,
} from "../google/calendar.js";
import type { CallService } from "./service.js";
import { leadSchema, type CallMode, type Lead } from "./types.js";

/**
 * Drives the calls that nobody submits a form for.
 *
 * Sweeps the shared demo calendar on a timer and decides, per upcoming event:
 *   - reminder   - the demo starts soon and we have not reminded this prospect
 *   - reschedule - the prospect declined the invitation
 * Both are placed through CallService, so the contact-frequency cap, the
 * idempotency key and the whole call lifecycle apply exactly as they do to a
 * form-triggered call. The calendar is the source of truth; this class keeps
 * no schedule of its own beyond what the calls table already records.
 */

/** A prospect on a demo event: the attendee who is not on the Lyzr domain. */
interface ProspectEvent {
  event: GoogleEvent;
  prospect: GoogleAttendee;
  start: string;
  end: string | null;
}

export interface SchedulerDeps {
  env: Env;
  repository: CallRepository;
  service: CallService;
  checker: DemoBookingChecker;
  logger: Logger;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SweepResult {
  eventsScanned: number;
  remindersPlaced: number;
  rescheduleCallsPlaced: number;
  skipped: number;
}

export class CallScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private readonly log: Logger;

  constructor(private readonly deps: SchedulerDeps) {
    this.log = deps.logger.child({ component: "call-scheduler" });
  }

  get enabled(): boolean {
    return this.deps.env.ENABLE_CALL_SCHEDULER;
  }

  private get now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Looks far enough ahead to catch every reminder before its lead time. */
  private get horizonMs(): number {
    return Math.max(this.deps.env.REMINDER_LEAD_MINUTES + 60, 24 * 60) * 60_000;
  }

  async sweep(): Promise<SweepResult> {
    const result: SweepResult = { eventsScanned: 0, remindersPlaced: 0, rescheduleCallsPlaced: 0, skipped: 0 };
    if (!this.enabled) return result;

    const events = await this.upcomingProspectEvents();
    result.eventsScanned = events.length;

    for (const item of events) {
      try {
        const declined = item.prospect.responseStatus === "declined";
        if (declined) {
          if (!this.deps.env.ENABLE_DECLINE_CALLS) continue;
          if (await this.place(item, "reschedule")) result.rescheduleCallsPlaced += 1;
          else result.skipped += 1;
          continue;
        }
        if (this.isReminderDue(item.start)) {
          if (await this.place(item, "reminder")) result.remindersPlaced += 1;
          else result.skipped += 1;
        }
      } catch (err) {
        // One bad event must never stop the sweep.
        this.log.error(
          { event: "scheduler_event_failed", event_id: item.event.id, err: err instanceof Error ? err.message : String(err) },
          "could not act on calendar event",
        );
      }
    }

    this.log.info({ event: "scheduler_sweep", ...result }, "calendar sweep complete");
    return result;
  }

  /**
   * True once the demo is within the lead time, but not so late that a call
   * would land after it has started (or barely before).
   */
  private isReminderDue(startIso: string): boolean {
    const { REMINDER_LEAD_MINUTES, REMINDER_GRACE_MINUTES } = this.deps.env;
    const minutesAway = (Date.parse(startIso) - this.now.getTime()) / 60_000;
    return minutesAway <= REMINDER_LEAD_MINUTES && minutesAway >= REMINDER_GRACE_MINUTES;
  }

  /**
   * Places one scheduled call, unless we have already placed that kind of call
   * for that meeting. Dedupe is by (meeting id, mode) in the calls table plus
   * the idempotency key, so a restart mid-sweep cannot double-dial.
   */
  private async place(item: ProspectEvent, mode: Extract<CallMode, "reminder" | "reschedule">): Promise<boolean> {
    const meetingId = item.event.id ?? "";
    const prospectEmail = item.prospect.email?.trim().toLowerCase() ?? "";
    if (!meetingId || !prospectEmail) return false;

    const existing = await this.deps.repository.findByMeetingAndMode(meetingId, mode);
    if (existing.length > 0) return false;

    const previous = await this.deps.repository.findLatestByEmail(prospectEmail);
    if (!previous?.phone) {
      // We only have a phone number for leads that came through the workflow.
      this.log.info(
        { event: "scheduler_no_phone", meeting_id: meetingId, mode, lead_email: prospectEmail },
        "no known phone number for this prospect; skipping",
      );
      return false;
    }

    const aeEmail = item.event.attendees?.find(
      (a) => a.email && a.email.toLowerCase() !== prospectEmail && a.email.toLowerCase() !== this.deps.checker.calendarId,
    )?.email ?? previous.ae_email ?? null;

    const parsed = leadSchema.safeParse({
      phone: previous.phone,
      email: prospectEmail,
      first_name: previous.first_name,
      last_name: previous.last_name,
      company: previous.company,
      use_case: previous.use_case,
      timezone: previous.timezone,
      call_mode: mode,
      // A reminder is only meaningful for a meeting that still stands; a
      // reschedule call is about the meeting they just declined.
      meeting_booked: true,
      meeting_id: meetingId,
      meeting_start: item.start,
      meeting_end: item.end,
      meeting_link: meetLink(item.event),
      meeting_owner: eventOwner(item.event, this.deps.checker.calendarId, prospectEmail),
      ae_email: aeEmail,
      ae_name: previous.ae_name,
    });
    if (!parsed.success) {
      this.log.warn(
        { event: "scheduler_lead_invalid", meeting_id: meetingId, mode, issues: parsed.error.issues.map((i) => i.path.join(".")) },
        "scheduled lead failed validation",
      );
      return false;
    }

    const lead: Lead = parsed.data;
    const idempotencyKey = `${mode}:${meetingId}`;

    try {
      const { call, replayed } = await this.deps.service.placeCall(lead, idempotencyKey);
      this.log.info(
        { event: "scheduler_call_placed", mode, meeting_id: meetingId, call_id: call.id, replayed, start: item.start },
        replayed ? "scheduled call already existed" : "placed scheduled call",
      );
      return !replayed;
    } catch (err) {
      // A refusal (contact cap, suppression) is a normal outcome, not a fault.
      const code = (err as { code?: string }).code;
      this.log.info(
        { event: "scheduler_call_refused", mode, meeting_id: meetingId, code, reason: err instanceof Error ? err.message : String(err) },
        "scheduled call not placed",
      );
      return false;
    }
  }

  /** Upcoming non-cancelled events that have a prospect (non-Lyzr) attendee. */
  private async upcomingProspectEvents(): Promise<ProspectEvent[]> {
    const timeMin = this.now;
    const timeMax = new Date(timeMin.getTime() + this.horizonMs);
    const domain = this.deps.checker.calendarId.split("@")[1]?.toLowerCase() ?? "";

    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: "2500",
    });
    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(this.deps.checker.calendarId)}/events?${params}`;
    const token = await this.deps.checker.auth.getAccessToken(SCOPE_CALENDAR);
    const page = await googleJson<{ items?: GoogleEvent[] }>(
      this.deps.fetchImpl ?? this.deps.checker.fetchImpl,
      url,
      { headers: { authorization: `Bearer ${token}` } },
      "scheduler.events.list",
    );

    const out: ProspectEvent[] = [];
    for (const event of page.items ?? []) {
      if (event.status === "cancelled") continue;
      const start = eventTime(event.start);
      if (!start) continue;
      const prospect = event.attendees?.find((a) => {
        const email = a.email?.toLowerCase();
        return email && domain && !email.endsWith(`@${domain}`);
      });
      if (!prospect) continue;
      out.push({ event, prospect, start, end: eventTime(event.end) });
    }
    return out;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    const intervalMs = this.deps.env.SCHEDULER_INTERVAL_SECONDS * 1000;
    this.timer = setInterval(() => {
      if (this.running) return; // never overlap sweeps
      this.running = true;
      void this.sweep()
        .catch((err) => this.log.error({ event: "scheduler_sweep_failed", err: String(err) }, "calendar sweep failed"))
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref?.();
    this.log.info({ event: "scheduler_started", interval_seconds: this.deps.env.SCHEDULER_INTERVAL_SECONDS }, "call scheduler started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
