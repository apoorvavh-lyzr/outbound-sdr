import type { Logger } from "pino";
import { UpstreamError } from "../utils/errors.js";

/**
 * Minimal HubSpot CRM client: who owns a lead, and what happened on the call.
 *
 * Only the two things this service needs - resolving the assigned owner so we
 * can read their calendar, and writing the call back onto the contact. No SDK,
 * because that is a large dependency for four endpoints.
 */

const API = "https://api.hubapi.com";
/** Owners change rarely; a short cache keeps a sweep from re-fetching per event. */
const OWNER_TTL_MS = 5 * 60_000;

export interface HubspotOwner {
  id: string;
  email: string;
  name?: string;
}

export interface HubspotContact {
  id: string;
  email: string | null;
  ownerId: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HubspotConfig {
  accessToken: string;
  timeoutMs?: number;
}

export class HubspotClient {
  private readonly ownerCache = new Map<string, { owner: HubspotOwner | null; expiresAt: number }>();

  constructor(
    private readonly config: HubspotConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}, stage = "hubspot"): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 10_000);
    try {
      let response: Response;
      try {
        response = await this.fetchImpl(`${API}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.config.accessToken}`,
            "content-type": "application/json",
            ...(init.headers as Record<string, string> | undefined),
          },
        });
      } catch (err) {
        throw new UpstreamError("hubspot_unavailable", `HubSpot request did not complete (${stage})`, 502, {
          stage,
          reason: err instanceof Error ? err.message : String(err),
        });
      }

      if (response.status === 404) return null as T;
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new UpstreamError("hubspot_error", `HubSpot returned ${response.status} (${stage})`, 502, {
          stage,
          status: response.status,
          body: body.slice(0, 300),
        });
      }
      if (response.status === 204) return null as T;
      return (await response.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** The contact with this email address, or null. Email match is exact. */
  async findContactByEmail(email: string): Promise<HubspotContact | null> {
    const body = {
      filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email.trim().toLowerCase() }] }],
      properties: ["email", "hubspot_owner_id"],
      limit: 1,
    };
    const json = await this.request<{
      results?: { id: string; properties?: Record<string, string | null> }[];
    }>("/crm/v3/objects/contacts/search", { method: "POST", body: JSON.stringify(body) }, "contacts.search");

    const hit = json?.results?.[0];
    if (!hit) return null;
    return {
      id: hit.id,
      email: hit.properties?.email ?? null,
      ownerId: hit.properties?.hubspot_owner_id || null,
    };
  }

  async getOwner(ownerId: string): Promise<HubspotOwner | null> {
    const cached = this.ownerCache.get(ownerId);
    if (cached && cached.expiresAt > this.now()) return cached.owner;

    const json = await this.request<{ id: string; email?: string; firstName?: string; lastName?: string } | null>(
      `/crm/v3/owners/${encodeURIComponent(ownerId)}`,
      {},
      "owners.get",
    );
    const owner: HubspotOwner | null = json?.email
      ? { id: json.id, email: json.email.trim().toLowerCase(), name: [json.firstName, json.lastName].filter(Boolean).join(" ") || undefined }
      : null;

    this.ownerCache.set(ownerId, { owner, expiresAt: this.now() + OWNER_TTL_MS });
    return owner;
  }

  /**
   * The person a lead is assigned to, by lead email. Null when the contact is
   * unknown or not yet assigned - assignment is asynchronous, so an unassigned
   * answer is normal rather than an error.
   */
  async ownerForLead(leadEmail: string): Promise<HubspotOwner | null> {
    const contact = await this.findContactByEmail(leadEmail);
    if (!contact?.ownerId) return null;
    return this.getOwner(contact.ownerId);
  }

  /**
   * Same, but waits for an assignment that is still being made. Polls at a
   * fixed interval up to `timeoutMs`; returns null rather than throwing when
   * the lead is simply not assigned yet.
   */
  async waitForOwner(leadEmail: string, timeoutMs: number, intervalMs = 2_000): Promise<HubspotOwner | null> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const owner = await this.ownerForLead(leadEmail).catch((err) => {
        this.logger.warn(
          { event: "hubspot_owner_lookup_failed", lead_email: leadEmail, err: err instanceof Error ? err.message : String(err) },
          "owner lookup failed",
        );
        return null;
      });
      if (owner) return owner;
      if (this.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - this.now()))));
    }
  }

  /** Logs the call on the contact's timeline and associates the two. */
  async logCall(contactId: string, call: CallActivity): Promise<string | null> {
    const json = await this.request<{ id: string } | null>(
      "/crm/v3/objects/calls",
      {
        method: "POST",
        body: JSON.stringify({
          properties: {
            hs_timestamp: call.timestamp,
            hs_call_title: call.title,
            hs_call_body: call.body,
            hs_call_direction: "OUTBOUND",
            hs_call_status: call.status,
            ...(call.durationMs !== undefined ? { hs_call_duration: String(call.durationMs) } : {}),
            ...(call.toNumber ? { hs_call_to_number: call.toNumber } : {}),
          },
          associations: [
            {
              to: { id: contactId },
              // 194 = call -> contact, HubSpot's defined association type.
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 194 }],
            },
          ],
        }),
      },
      "calls.create",
    );
    return json?.id ?? null;
  }

  /** Attaches a note (the transcript summary) to the contact. */
  async addNote(contactId: string, body: string, timestamp: string): Promise<string | null> {
    const json = await this.request<{ id: string } | null>(
      "/crm/v3/objects/notes",
      {
        method: "POST",
        body: JSON.stringify({
          properties: { hs_timestamp: timestamp, hs_note_body: body },
          associations: [
            {
              to: { id: contactId },
              // 202 = note -> contact.
              types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
            },
          ],
        }),
      },
      "notes.create",
    );
    return json?.id ?? null;
  }

  /** Updates contact properties. Unknown properties are the caller's problem to avoid. */
  async updateContact(contactId: string, properties: Record<string, string>): Promise<void> {
    if (Object.keys(properties).length === 0) return;
    await this.request(
      `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`,
      { method: "PATCH", body: JSON.stringify({ properties }) },
      "contacts.update",
    );
  }
}

export interface CallActivity {
  /** ISO 8601. */
  timestamp: string;
  title: string;
  body: string;
  /** HubSpot call outcome, e.g. COMPLETED, NO_ANSWER, BUSY, FAILED. */
  status: string;
  durationMs?: number;
  toNumber?: string;
}
