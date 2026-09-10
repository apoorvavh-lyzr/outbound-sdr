/**
 * Schema DDL. Written twice because the two supported drivers differ on a few
 * types (JSONB vs TEXT, BOOLEAN vs INTEGER). The column set is identical.
 */

export const POSTGRES_DDL = `
CREATE TABLE IF NOT EXISTS calls (
  id                        UUID PRIMARY KEY,
  idempotency_key           TEXT UNIQUE,

  phone                     TEXT NOT NULL,
  email                     TEXT NOT NULL,
  first_name                TEXT NOT NULL DEFAULT '',
  last_name                 TEXT NOT NULL DEFAULT '',
  company                   TEXT NOT NULL DEFAULT '',
  use_case                  TEXT NOT NULL DEFAULT '',
  call_mode                 TEXT NOT NULL,
  timezone                  TEXT NOT NULL DEFAULT 'Asia/Kolkata',

  meeting_booked            BOOLEAN NOT NULL DEFAULT FALSE,
  meeting_id                TEXT,
  meeting_start             TEXT,
  meeting_end               TEXT,
  meeting_link              TEXT,
  meeting_owner             TEXT,

  status                    TEXT NOT NULL,

  twilio_call_sid           TEXT,
  twilio_stream_sid         TEXT,

  lyzr_base_agent_id        TEXT,
  lyzr_call_agent_id        TEXT,
  lyzr_session_id           TEXT,

  reschedule_required       BOOLEAN NOT NULL DEFAULT FALSE,
  preferred_replacement_slot TEXT,
  prospect_notes            TEXT,

  error_code                TEXT,
  error_message             TEXT,

  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at               TIMESTAMPTZ,
  completed_at              TIMESTAMPTZ,
  post_call_callback_sent_at TIMESTAMPTZ,

  raw_twilio_status         JSONB,
  metadata                  JSONB
);

CREATE INDEX IF NOT EXISTS calls_twilio_call_sid_idx ON calls (twilio_call_sid);
CREATE INDEX IF NOT EXISTS calls_status_idx ON calls (status);
CREATE INDEX IF NOT EXISTS calls_created_at_idx ON calls (created_at DESC);

CREATE TABLE IF NOT EXISTS callback_attempts (
  id            BIGSERIAL PRIMARY KEY,
  call_id       UUID NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  attempt       INTEGER NOT NULL,
  status_code   INTEGER,
  ok            BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS callback_attempts_call_id_idx ON callback_attempts (call_id);
`;

export const SQLITE_DDL = `
CREATE TABLE IF NOT EXISTS calls (
  id                        TEXT PRIMARY KEY,
  idempotency_key           TEXT UNIQUE,

  phone                     TEXT NOT NULL,
  email                     TEXT NOT NULL,
  first_name                TEXT NOT NULL DEFAULT '',
  last_name                 TEXT NOT NULL DEFAULT '',
  company                   TEXT NOT NULL DEFAULT '',
  use_case                  TEXT NOT NULL DEFAULT '',
  call_mode                 TEXT NOT NULL,
  timezone                  TEXT NOT NULL DEFAULT 'Asia/Kolkata',

  meeting_booked            INTEGER NOT NULL DEFAULT 0,
  meeting_id                TEXT,
  meeting_start             TEXT,
  meeting_end               TEXT,
  meeting_link              TEXT,
  meeting_owner             TEXT,

  status                    TEXT NOT NULL,

  twilio_call_sid           TEXT,
  twilio_stream_sid         TEXT,

  lyzr_base_agent_id        TEXT,
  lyzr_call_agent_id        TEXT,
  lyzr_session_id           TEXT,

  reschedule_required       INTEGER NOT NULL DEFAULT 0,
  preferred_replacement_slot TEXT,
  prospect_notes            TEXT,

  error_code                TEXT,
  error_message             TEXT,

  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  answered_at               TEXT,
  completed_at              TEXT,
  post_call_callback_sent_at TEXT,

  raw_twilio_status         TEXT,
  metadata                  TEXT
);

CREATE INDEX IF NOT EXISTS calls_twilio_call_sid_idx ON calls (twilio_call_sid);
CREATE INDEX IF NOT EXISTS calls_status_idx ON calls (status);

CREATE TABLE IF NOT EXISTS callback_attempts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id       TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  status_code   INTEGER,
  ok            INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS callback_attempts_call_id_idx ON callback_attempts (call_id);
`;

/** Column order shared by both drivers for INSERT. */
/**
 * Additive migrations for databases created before a column existed. The DDL
 * above only runs CREATE TABLE IF NOT EXISTS, so an existing Railway database
 * never picks up a new column without these.
 */
export const POSTGRES_ALTERS = [
  "ALTER TABLE calls ADD COLUMN IF NOT EXISTS post_call_callback_sent_at TIMESTAMPTZ",
];

/** SQLite has no IF NOT EXISTS for ADD COLUMN; a duplicate-column error is expected and ignored. */
export const SQLITE_ALTERS = [
  "ALTER TABLE calls ADD COLUMN post_call_callback_sent_at TEXT",
];

export const CALL_COLUMNS = [
  "id",
  "idempotency_key",
  "phone",
  "email",
  "first_name",
  "last_name",
  "company",
  "use_case",
  "call_mode",
  "timezone",
  "meeting_booked",
  "meeting_id",
  "meeting_start",
  "meeting_end",
  "meeting_link",
  "meeting_owner",
  "status",
  "twilio_call_sid",
  "twilio_stream_sid",
  "lyzr_base_agent_id",
  "lyzr_call_agent_id",
  "lyzr_session_id",
  "reschedule_required",
  "preferred_replacement_slot",
  "prospect_notes",
  "error_code",
  "error_message",
  "created_at",
  "updated_at",
  "answered_at",
  "completed_at",
  "post_call_callback_sent_at",
  "raw_twilio_status",
  "metadata",
] as const;

export type CallColumn = (typeof CALL_COLUMNS)[number];

/** Columns an UPDATE is ever allowed to touch. */
export const UPDATABLE_COLUMNS: readonly CallColumn[] = CALL_COLUMNS.filter(
  (c) => c !== "id" && c !== "idempotency_key" && c !== "created_at",
);
