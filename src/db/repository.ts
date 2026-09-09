import { randomUUID } from "node:crypto";
import type { Database } from "./client.js";
import { CALL_COLUMNS, UPDATABLE_COLUMNS, type CallColumn } from "./schema.js";
import type { CallMode, CallRecord, CallStatus, Lead } from "../calls/types.js";

const BOOLEAN_COLUMNS = new Set<CallColumn>(["meeting_booked", "reschedule_required"]);
const JSON_COLUMNS = new Set<CallColumn>(["raw_twilio_status", "metadata"]);

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Normalises a driver row into a CallRecord (pg and sqlite disagree on types). */
function hydrate(row: Record<string, unknown>): CallRecord {
  const bool = (v: unknown) => v === true || v === 1 || v === "1" || v === "t" || v === "true";
  const json = (v: unknown) => {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") {
      try {
        return JSON.parse(v);
      } catch {
        return null;
      }
    }
    return v;
  };
  const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

  return {
    id: String(row.id),
    idempotency_key: str(row.idempotency_key),
    phone: String(row.phone),
    email: String(row.email),
    first_name: String(row.first_name ?? ""),
    last_name: String(row.last_name ?? ""),
    company: String(row.company ?? ""),
    use_case: String(row.use_case ?? ""),
    call_mode: String(row.call_mode) as CallMode,
    timezone: String(row.timezone ?? "Asia/Kolkata"),

    meeting_booked: bool(row.meeting_booked),
    meeting_id: str(row.meeting_id),
    meeting_start: str(row.meeting_start),
    meeting_end: str(row.meeting_end),
    meeting_link: str(row.meeting_link),
    meeting_owner: str(row.meeting_owner),

    status: String(row.status) as CallStatus,

    twilio_call_sid: str(row.twilio_call_sid),
    twilio_stream_sid: str(row.twilio_stream_sid),

    lyzr_base_agent_id: str(row.lyzr_base_agent_id),
    lyzr_call_agent_id: str(row.lyzr_call_agent_id),
    lyzr_session_id: str(row.lyzr_session_id),

    reschedule_required: bool(row.reschedule_required),
    preferred_replacement_slot: str(row.preferred_replacement_slot),
    prospect_notes: str(row.prospect_notes),

    error_code: str(row.error_code),
    error_message: str(row.error_message),

    created_at: toIso(row.created_at) ?? nowIso(),
    updated_at: toIso(row.updated_at) ?? nowIso(),
    answered_at: toIso(row.answered_at),
    completed_at: toIso(row.completed_at),

    raw_twilio_status: json(row.raw_twilio_status),
    metadata: json(row.metadata) as Record<string, unknown> | null,
  };
}

/** Encodes a JS value for whichever driver is active. */
function encode(db: Database, column: CallColumn, value: unknown): unknown {
  if (JSON_COLUMNS.has(column)) {
    if (value === null || value === undefined) return null;
    return db.dialect === "sqlite" ? JSON.stringify(value) : JSON.stringify(value);
  }
  if (BOOLEAN_COLUMNS.has(column) && db.dialect === "sqlite") {
    return value ? 1 : 0;
  }
  return value ?? null;
}

export type CallUpdate = Partial<Omit<CallRecord, "id" | "idempotency_key" | "created_at">>;

export class CallRepository {
  constructor(private readonly db: Database) {}

  async create(lead: Lead, idempotencyKey: string | null, baseAgentId: string | null): Promise<CallRecord> {
    const timestamp = nowIso();
    const record: CallRecord = {
      id: randomUUID(),
      idempotency_key: idempotencyKey,
      phone: lead.phone,
      email: lead.email,
      first_name: lead.first_name,
      last_name: lead.last_name,
      company: lead.company,
      use_case: lead.use_case,
      call_mode: lead.call_mode,
      timezone: lead.timezone,
      meeting_booked: lead.meeting_booked,
      meeting_id: lead.meeting_id,
      meeting_start: lead.meeting_start,
      meeting_end: lead.meeting_end,
      meeting_link: lead.meeting_link,
      meeting_owner: lead.meeting_owner,
      status: "created",
      twilio_call_sid: null,
      twilio_stream_sid: null,
      lyzr_base_agent_id: baseAgentId,
      lyzr_call_agent_id: null,
      lyzr_session_id: null,
      reschedule_required: false,
      preferred_replacement_slot: null,
      prospect_notes: null,
      error_code: null,
      error_message: null,
      created_at: timestamp,
      updated_at: timestamp,
      answered_at: null,
      completed_at: null,
      raw_twilio_status: null,
      metadata: null,
    };

    const placeholders = CALL_COLUMNS.map(() => "?").join(", ");
    const values = CALL_COLUMNS.map((c) => encode(this.db, c, record[c as keyof CallRecord]));

    await this.db.execute(
      `INSERT INTO calls (${CALL_COLUMNS.join(", ")}) VALUES (${placeholders})`,
      values,
    );
    return record;
  }

  async findById(id: string): Promise<CallRecord | null> {
    const rows = await this.db.query("SELECT * FROM calls WHERE id = ?", [id]);
    return rows[0] ? hydrate(rows[0]) : null;
  }

  async findByIdempotencyKey(key: string): Promise<CallRecord | null> {
    const rows = await this.db.query("SELECT * FROM calls WHERE idempotency_key = ?", [key]);
    return rows[0] ? hydrate(rows[0]) : null;
  }

  async findByTwilioCallSid(sid: string): Promise<CallRecord | null> {
    const rows = await this.db.query(
      "SELECT * FROM calls WHERE twilio_call_sid = ? ORDER BY created_at DESC LIMIT 1",
      [sid],
    );
    return rows[0] ? hydrate(rows[0]) : null;
  }

  async update(id: string, patch: CallUpdate): Promise<CallRecord> {
    const columns = UPDATABLE_COLUMNS.filter((c) => c in patch);
    const timestamp = nowIso();

    const assignments = [...columns.map((c) => `${c} = ?`), "updated_at = ?"];
    const values = [
      ...columns.map((c) => encode(this.db, c, (patch as Record<string, unknown>)[c])),
      timestamp,
      id,
    ];

    await this.db.execute(`UPDATE calls SET ${assignments.join(", ")} WHERE id = ?`, values);

    const updated = await this.findById(id);
    if (!updated) throw new Error(`Call ${id} disappeared during update`);
    return updated;
  }

  async recordCallbackAttempt(
    callId: string,
    attempt: number,
    ok: boolean,
    statusCode: number | null,
    errorMessage: string | null,
  ): Promise<void> {
    await this.db.execute(
      `INSERT INTO callback_attempts (call_id, attempt, status_code, ok, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        callId,
        attempt,
        statusCode,
        this.db.dialect === "sqlite" ? (ok ? 1 : 0) : ok,
        errorMessage,
        nowIso(),
      ],
    );
  }

  /** Forgets a cloned agent id once the agent has actually been deleted. */
  async clearClonedAgent(callId: string): Promise<void> {
    await this.db.execute("UPDATE calls SET lyzr_call_agent_id = NULL, updated_at = ? WHERE id = ?", [
      nowIso(),
      callId,
    ]);
  }

  /** Cloned agents older than the retention window, for later cleanup. */
  async findExpiredClonedAgents(olderThanIso: string): Promise<Array<{ id: string; agentId: string }>> {
    const rows = await this.db.query(
      `SELECT id, lyzr_call_agent_id FROM calls
       WHERE lyzr_call_agent_id IS NOT NULL AND completed_at IS NOT NULL AND completed_at < ?`,
      [olderThanIso],
    );
    return rows.map((r) => ({ id: String(r.id), agentId: String(r.lyzr_call_agent_id) }));
  }
}

/** True when an error is a unique-constraint violation on idempotency_key. */
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (code === "23505") return true; // PostgreSQL unique_violation
  const message = err instanceof Error ? err.message : "";
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(message);
}
