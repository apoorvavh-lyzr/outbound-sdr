import { createSign } from "node:crypto";
import type { Logger } from "pino";
import { UpstreamError } from "../utils/errors.js";

/**
 * Service-account access to the shared demo calendar.
 *
 * Authenticates with a Domain-Wide-Delegation JWT (subject = the impersonated
 * mailbox) so nobody ever has to complete an OAuth consent flow. Tokens are
 * requested per scope, cached in memory and refreshed shortly before expiry.
 */

const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
/**
 * The single scope delegated to the service account in the Workspace admin
 * console. Booking needs write access, and Google refuses a token for any
 * scope that is not delegated verbatim, so the read-only check uses this
 * same scope rather than requiring calendar.readonly to be delegated too.
 */
export const SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar";
/** Refresh this long before Google says the token expires. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;
/** Google's hard cap per page. */
const MAX_RESULTS = 2500;

export interface GoogleServiceAccountConfig {
  serviceAccountEmail: string;
  /** PEM. Escaped "\n" sequences (as .env files store them) are unescaped here. */
  privateKey: string;
  privateKeyId?: string;
  /** Mailbox to impersonate, e.g. demos@lyzr.ai. */
  impersonatedUser: string;
}

export interface DemoCheckConfig {
  calendarId: string;
  windowDays: number;
  timeoutMs: number;
}

export interface MatchedEvent {
  /** Which calendar the event was found on. */
  calendar_id: string;
  id: string;
  summary: string | null;
  start: string | null;
  end: string | null;
  html_link: string | null;
  meet_link: string | null;
  /** The Lyzr person running the demo: first non-lead attendee on the calendar's domain, else the organizer. */
  owner: string | null;
}

export interface DemoCheckResult {
  alreadyBooked: boolean;
  event: MatchedEvent | null;
  eventsScanned: number;
  /** Every calendar consulted, in order. */
  calendarsChecked: string[];
}

export interface GoogleAttendee {
  email?: string;
  displayName?: string;
  responseStatus?: string;
  self?: boolean;
}

export interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  htmlLink?: string;
  organizer?: { email?: string; displayName?: string };
  hangoutLink?: string;
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: GoogleAttendee[];
}

interface EventsListResponse {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

/** Minimal HTTP surface so tests can substitute a stub. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export function normalizePrivateKey(raw: string): string {
  return raw.replace(/\\n/g, "\n");
}

export class GoogleServiceAccountAuth {
  private readonly tokens = new Map<string, { value: string; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly key: string;

  constructor(
    private readonly config: GoogleServiceAccountConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.key = normalizePrivateKey(config.privateKey);
  }

  /**
   * `subject` overrides the default impersonated user, so one service account
   * can read the shared demo calendar and an individual AE's calendar in the
   * same request. Tokens are cached per scope+subject.
   */
  async getAccessToken(scope: string, signal?: AbortSignal, subject?: string): Promise<string> {
    const user = subject?.trim().toLowerCase() || this.config.impersonatedUser;
    const key = `${scope}|${user}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return cached.value;
    }
    // Coalesce concurrent refreshes into one token exchange per scope.
    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.exchange(scope, user, key, signal).finally(() => {
        this.inflight.delete(key);
      });
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private signAssertion(scope: string, subject: string): string {
    const iat = Math.floor(this.now() / 1000);
    const header: Record<string, string> = { alg: "RS256", typ: "JWT" };
    if (this.config.privateKeyId) header.kid = this.config.privateKeyId;
    const claims = {
      iss: this.config.serviceAccountEmail,
      sub: subject,
      scope,
      aud: TOKEN_URL,
      iat,
      exp: iat + 3600,
    };
    const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signer = createSign("RSA-SHA256");
    signer.update(unsigned);
    return `${unsigned}.${b64url(signer.sign(this.key))}`;
  }

  private async exchange(scope: string, subject: string, key: string, signal?: AbortSignal): Promise<string> {
    let assertion: string;
    try {
      assertion = this.signAssertion(scope, subject);
    } catch (err) {
      // Never include the key material in the message.
      throw new UpstreamError("calendar_check_failed", "Google private key could not be used for signing", 502, {
        stage: "sign",
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    });

    let response: Response;
    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal,
      });
    } catch (err) {
      throw new UpstreamError("calendar_check_failed", "Google token exchange did not complete", 502, {
        stage: "token",
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const json = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!response.ok || !json.access_token) {
      throw new UpstreamError(
        "calendar_check_failed",
        `Google token exchange failed for ${subject} (${response.status})${json.error ? `: ${json.error}` : ""}`,
        502,
        { stage: "token", subject, status: response.status, error: json.error, description: json.error_description },
      );
    }

    this.tokens.set(key, {
      value: json.access_token,
      expiresAt: this.now() + (json.expires_in ?? 3600) * 1000,
    });
    return json.access_token;
  }
}

/**
 * Shared Google request wrapper: network failure, non-2xx and unparseable
 * bodies all become UpstreamError(code) so callers can never mistake them for
 * a definitive answer.
 */
export async function googleJson<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  stage: string,
  code = "calendar_check_failed",
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (err) {
    throw new UpstreamError(code, `Google Calendar request did not complete (${stage})`, 502, {
      stage,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new UpstreamError(code, `Google Calendar returned ${response.status} (${stage})`, 502, {
      stage,
      status: response.status,
      body: text.slice(0, 300),
    });
  }
  const json = (await response.json().catch(() => null)) as T | null;
  if (!json || typeof json !== "object") {
    throw new UpstreamError(code, `Google Calendar returned a malformed response (${stage})`, 502, { stage });
  }
  return json;
}

export function meetLink(event: GoogleEvent): string | null {
  return (
    event.hangoutLink ??
    event.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri ??
    null
  );
}

/**
 * The shared calendar first, then the assigned AE's own calendar when there is
 * one. De-duplicated, so an AE who *is* the demo mailbox is read once.
 */
export function calendarsToCheck(calendarId: string, aeEmail?: string): string[] {
  const ae = aeEmail?.trim().toLowerCase();
  return ae && ae !== calendarId.toLowerCase() ? [calendarId, ae] : [calendarId];
}

export function eventOwner(event: GoogleEvent, calendarId: string, leadEmail: string): string | null {
  const domain = calendarId.split("@")[1]?.toLowerCase();
  const host = event.attendees?.find((a) => {
    const email = a.email?.toLowerCase();
    return email && email !== leadEmail && email !== calendarId.toLowerCase() && domain && email.endsWith(`@${domain}`);
  });
  if (host) return host.displayName ?? host.email ?? null;
  return event.organizer?.displayName ?? event.organizer?.email ?? null;
}

export function eventTime(edge: GoogleEvent["start"]): string | null {
  return edge?.dateTime ?? edge?.date ?? null;
}

/**
 * Pure matching rule. Exported so the policy is unit-testable in isolation:
 *   - cancelled events never match
 *   - the lead must appear as an attendee (email, case-insensitive)
 *   - a declined attendee is treated as not booked
 * Organizer, creator, title and lead name are deliberately ignored.
 */
export function eventMatchesLead(event: GoogleEvent, leadEmail: string): boolean {
  if (event.status === "cancelled") return false;
  return (
    event.attendees?.some(
      (a) => a.email?.trim().toLowerCase() === leadEmail && a.responseStatus !== "declined",
    ) ?? false
  );
}

export class DemoBookingChecker {
  constructor(
    readonly auth: GoogleServiceAccountAuth,
    private readonly config: DemoCheckConfig,
    private readonly logger: Logger,
    /** Shared with DemoBooker so both talk to the same (stubbable) HTTP client. */
    readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get calendarId(): string {
    return this.config.calendarId;
  }

  /**
   * Looks for an upcoming (now → +windowDays) non-cancelled event with
   * `leadEmail` as a non-declined attendee, on the shared demo calendar and -
   * when the lead has been assigned one - the AE's own calendar, since AEs
   * sometimes book straight from their own. Any failure to get a definitive
   * answer throws an UpstreamError("calendar_check_failed") - the caller must
   * NOT interpret that as "not booked".
   */
  async check(leadEmail: string, aeEmail?: string): Promise<DemoCheckResult> {
    const email = leadEmail.trim().toLowerCase();
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    const timeMin = this.now();
    const timeMax = new Date(timeMin.getTime() + this.config.windowDays * 24 * 60 * 60 * 1000);
    const calendars = calendarsToCheck(this.config.calendarId, aeEmail);

    try {
      let scanned = 0;

      for (const calendarId of calendars) {
        // Each calendar is read as its own owner: the service account
        // impersonates the AE rather than relying on demos@ having been
        // granted access to their calendar.
        const token = await this.auth.getAccessToken(SCOPE_CALENDAR, controller.signal, calendarId);
        let pageToken: string | undefined;

        do {
          const page = await this.listPage(calendarId, token, email, timeMin, timeMax, pageToken, controller.signal);
          for (const event of page.items ?? []) {
            scanned += 1;
            if (eventMatchesLead(event, email)) {
              const matched: MatchedEvent = {
                calendar_id: calendarId,
                id: event.id ?? "",
                summary: event.summary ?? null,
                start: eventTime(event.start),
                end: eventTime(event.end),
                html_link: event.htmlLink ?? null,
                meet_link: meetLink(event),
                owner: eventOwner(event, calendarId, email),
              };
              this.logResult(email, true, matched.id, scanned, startedAt, calendars, calendarId);
              return { alreadyBooked: true, event: matched, eventsScanned: scanned, calendarsChecked: calendars };
            }
          }
          pageToken = page.nextPageToken;
        } while (pageToken);
      }

      this.logResult(email, false, null, scanned, startedAt, calendars, null);
      return { alreadyBooked: false, event: null, eventsScanned: scanned, calendarsChecked: calendars };
    } catch (err) {
      const error = controller.signal.aborted
        ? new UpstreamError("calendar_check_failed", `Calendar check timed out after ${this.config.timeoutMs}ms`, 502, {
            stage: err instanceof UpstreamError ? (err.details as { stage?: string })?.stage : undefined,
          })
        : err instanceof UpstreamError
          ? err
          : new UpstreamError("calendar_check_failed", "Calendar check failed", 502, {
              reason: err instanceof Error ? err.message : String(err),
            });
      this.logger.error(
        {
          event: "demo_check_failed",
          lead_email: email,
          calendars_checked: calendars,
          error: error.message,
          details: error.details,
          duration_ms: Date.now() - startedAt,
        },
        "could not determine demo booking status",
      );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private async listPage(
    calendarId: string,
    token: string,
    email: string,
    timeMin: Date,
    timeMax: Date,
    pageToken: string | undefined,
    signal: AbortSignal,
  ): Promise<EventsListResponse> {
    const params = new URLSearchParams({
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      showDeleted: "false",
      maxResults: String(MAX_RESULTS),
      // Server-side prefilter only; eventMatchesLead is still the authority.
      q: email,
    });
    if (pageToken) params.set("pageToken", pageToken);

    const url = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
    const json = await googleJson<EventsListResponse>(
      this.fetchImpl,
      url,
      { headers: { authorization: `Bearer ${token}` }, signal },
      "events.list",
    );
    if (json.items !== undefined && !Array.isArray(json.items)) {
      throw new UpstreamError("calendar_check_failed", "Google Calendar returned a malformed response", 502, {
        stage: "events.list",
      });
    }
    return json;
  }

  private logResult(
    email: string,
    booked: boolean,
    eventId: string | null,
    scanned: number,
    startedAt: number,
    calendars: string[],
    matchedOn: string | null,
  ) {
    this.logger.info(
      {
        event: "demo_check",
        lead_email: email,
        calendars_checked: calendars,
        matched_calendar_id: matchedOn,
        window_days: this.config.windowDays,
        already_booked: booked,
        matched_event_id: eventId,
        events_scanned: scanned,
        duration_ms: Date.now() - startedAt,
      },
      booked ? "lead already has a demo booked" : "no demo booking found for lead",
    );
  }
}
