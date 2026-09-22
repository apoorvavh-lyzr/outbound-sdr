import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())));

const int = (def: number, min = 0) =>
  z
    .union([z.number(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().min(min));

/** Empty strings from .env files are treated as "not set". */
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: int(3000, 1),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

    PUBLIC_BASE_URL: optionalStr,

    LYZR_API_KEY: optionalStr,
    LYZR_BASE_AGENT_ID: optionalStr,
    LYZR_VOICE_API_BASE: optionalStr.pipe(z.string().default("https://voice-livekit.studio.lyzr.ai/v1")),
    LYZR_TRANSCRIPT_URL_TEMPLATE: optionalStr,
    LYZR_SESSION_TIMEOUT_MS: int(15000, 1000),
    // Emergency fallback only. The production path reuses the saved agent and
    // passes lead context as per-session agentConfig.
    LYZR_ENABLE_AGENT_CLONING: bool.optional().default(false),
    LYZR_HTTP_TIMEOUT_MS: int(20000, 1000),

    TWILIO_ACCOUNT_SID: optionalStr,
    TWILIO_AUTH_TOKEN: optionalStr,
    TWILIO_PHONE_NUMBER: optionalStr,
    TWILIO_CALL_TIMEOUT_SECONDS: int(45, 5),
    TWILIO_VALIDATE_WEBHOOKS: bool.optional().default(true),

    SUPERFLOW_SHARED_SECRET: optionalStr,
    SUPERFLOW_CALLBACK_URL: optionalStr,
    SUPERFLOW_CALLBACK_SECRET: optionalStr,
    /**
     * Set when SUPERFLOW_CALLBACK_URL is the Lyzr workflow-execute API rather
     * than a plain webhook. Its presence switches the callback to that API's
     * shape: x-webhook-secret plus {workflow_id, input:[...]}.
     */
    SUPERFLOW_CALLBACK_WORKFLOW_ID: optionalStr,
    /** Intake webhook the demo form forwards leads to. Never sent to the browser. */
    SUPERFLOW_INTAKE_WEBHOOK_URL: optionalStr,
    /** Sent as the x-webhook-secret header; the execute API rejects the call without it. */
    SUPERFLOW_INTAKE_WEBHOOK_SECRET: optionalStr,
    /** Workflow the intake call executes. The execute API 400s without it. */
    SUPERFLOW_INTAKE_WORKFLOW_ID: optionalStr,

    DATABASE_URL: optionalStr,

    AUDIO_PRECONNECT_BUFFER_MS: int(1000, 100),
    CALL_RATE_LIMIT_MAX: int(30, 1),
    CALL_RATE_LIMIT_WINDOW_MS: int(60000, 1000),

    MOCK_EXTERNAL_SERVICES: bool.optional().default(false),
    CLONED_AGENT_RETENTION_HOURS: int(72, 0),
    ENABLE_DNC_CHECK: bool.optional().default(false),

    /**
     * Google Workspace service account with Domain-Wide Delegation, used by
     * POST /check-demo-booking to read the shared demo calendar. All four are
     * required together; none is boot-blocking - the calling service must
     * never fail to start because the demo-check variables are missing.
     * The endpoint answers 503 calendar_check_failed until they are set.
     */
    GOOGLE_SERVICE_ACCOUNT_EMAIL: optionalStr,
    GOOGLE_PRIVATE_KEY: optionalStr,
    GOOGLE_PRIVATE_KEY_ID: optionalStr,
    /** Documented for the DWD admin setup; not needed at runtime. */
    GOOGLE_CLIENT_ID: optionalStr,
    /** Mailbox the service account impersonates AND the calendar that is read. */
    GOOGLE_IMPERSONATED_USER: optionalStr.pipe(z.string().default("demos@lyzr.ai")),
    /** Override only if the demo calendar is not the impersonated user's primary. */
    GOOGLE_DEMO_CALENDAR_ID: optionalStr,
    DEMO_CHECK_WINDOW_DAYS: int(90, 1),
    DEMO_CHECK_TIMEOUT_MS: int(10000, 1000),
    /** Business hours for /demo-slots, expressed in DEMO_TIMEZONE. */
    DEMO_TIMEZONE: optionalStr.pipe(z.string().default("Asia/Kolkata")),
    DEMO_HOURS_START: int(10, 0),
    DEMO_HOURS_END: int(18, 1),
    /** Comma-separated 0=Sun…6=Sat. */
    DEMO_WORKING_DAYS: optionalStr.pipe(z.string().default("1,2,3,4,5")),
    DEMO_SLOT_MINUTES: int(30, 15),
    DEMO_MIN_NOTICE_MINUTES: int(60, 0),
    /** Extra Lyzr attendees added to every booking (comma-separated). */
    DEMO_HOST_EMAILS: optionalStr,
    /**
     * Tool names or URL fragments that must appear in the base agent's config
     * before a call is dialled. Defaults to the Composio calendar actions;
     * once the agent books through this backend, set it to the names Lyzr
     * generated for the custom tool set (openapi-<toolset>-<operationId>).
     * Empty string disables the gate.
     */
    LYZR_REQUIRED_AGENT_TOOLS: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? "GOOGLECALENDAR_FIND_FREE_SLOTS,GOOGLECALENDAR_CREATE_EVENT" : v.trim())),
    /**
     * Second safety net: also run the demo-booking check inside POST /api/call.
     * A booked lead is refused with 409 and a calendar failure with 502, even
     * if SuperFlow skipped /check-demo-booking. Off until the endpoint is proven.
     */
    ENABLE_DEMO_BOOKING_GUARD: bool.optional().default(false),

    /**
     * Directory for one debug WAV of the agent's audio per call, captured
     * BEFORE mu-law conversion. Development only - refused in production,
     * where retaining call audio is a privacy and memory problem.
     */
    DEBUG_AUDIO_DIR: optionalStr,
  })
  .superRefine((env, ctx) => {
    const requireLive = env.NODE_ENV === "production" || !env.MOCK_EXTERNAL_SERVICES;
    const need = (key: keyof typeof env, value: unknown) => {
      if (!value) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key as string],
          message: `${key} is required when MOCK_EXTERNAL_SERVICES is false or NODE_ENV=production`,
        });
      }
    };

    if (requireLive) {
      need("PUBLIC_BASE_URL", env.PUBLIC_BASE_URL);
      need("LYZR_API_KEY", env.LYZR_API_KEY);
      need("LYZR_BASE_AGENT_ID", env.LYZR_BASE_AGENT_ID);
      need("TWILIO_ACCOUNT_SID", env.TWILIO_ACCOUNT_SID);
      need("TWILIO_AUTH_TOKEN", env.TWILIO_AUTH_TOKEN);
      need("TWILIO_PHONE_NUMBER", env.TWILIO_PHONE_NUMBER);
      need("SUPERFLOW_SHARED_SECRET", env.SUPERFLOW_SHARED_SECRET);
    }

    // The intake variables are deliberately NOT boot-blocking. They configure
    // the demo form only; the outbound calling service must never fail to start
    // because a lead-form variable is missing. /api/lead answers 503 instead.

    if (env.NODE_ENV === "production" && env.DEBUG_AUDIO_DIR) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEBUG_AUDIO_DIR"],
        message: "DEBUG_AUDIO_DIR records call audio and must not be set in production",
      });
    }

    if (env.NODE_ENV === "production") {
      need("DATABASE_URL", env.DATABASE_URL);

      if (env.PUBLIC_BASE_URL) {
        const fail = (message: string) =>
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["PUBLIC_BASE_URL"], message });

        if (!env.PUBLIC_BASE_URL.startsWith("https://")) {
          fail("PUBLIC_BASE_URL must start with https:// so the Twilio Stream URL is wss://");
        } else {
          // Catches "https://" with nothing after it, which is what
          // https://${{RAILWAY_PUBLIC_DOMAIN}} expands to before a domain has
          // been generated. Twilio would then be handed "wss:///twilio-media".
          let hostname = "";
          try {
            hostname = new URL(env.PUBLIC_BASE_URL).hostname;
          } catch {
            hostname = "";
          }
          if (!hostname) {
            fail(
              "PUBLIC_BASE_URL has no hostname. If you used ${{RAILWAY_PUBLIC_DOMAIN}}, " +
                "generate a public domain first (Settings -> Networking -> Generate Domain).",
            );
          }
        }
      }
    }

    if (env.DEMO_HOURS_END <= env.DEMO_HOURS_START || env.DEMO_HOURS_END > 24) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["DEMO_HOURS_END"],
        message: "DEMO_HOURS_END must be after DEMO_HOURS_START and at most 24",
      });
    }
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: env.DEMO_TIMEZONE });
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["DEMO_TIMEZONE"], message: "DEMO_TIMEZONE is not a valid IANA zone" });
    }

    const googleVars = [env.GOOGLE_SERVICE_ACCOUNT_EMAIL, env.GOOGLE_PRIVATE_KEY];
    const googleSet = googleVars.filter(Boolean).length;
    if (googleSet > 0 && googleSet < googleVars.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["GOOGLE_SERVICE_ACCOUNT_EMAIL"],
        message: "GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY must be set together",
      });
    }
    if (env.ENABLE_DEMO_BOOKING_GUARD && googleSet < googleVars.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ENABLE_DEMO_BOOKING_GUARD"],
        message: "ENABLE_DEMO_BOOKING_GUARD requires the GOOGLE_* service-account variables",
      });
    }

    if (env.SUPERFLOW_CALLBACK_URL && !/^https?:\/\//.test(env.SUPERFLOW_CALLBACK_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPERFLOW_CALLBACK_URL"],
        message: "SUPERFLOW_CALLBACK_URL must be an absolute http(s) URL",
      });
    }

    if (env.SUPERFLOW_INTAKE_WEBHOOK_URL && !/^https?:\/\//.test(env.SUPERFLOW_INTAKE_WEBHOOK_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPERFLOW_INTAKE_WEBHOOK_URL"],
        message: "SUPERFLOW_INTAKE_WEBHOOK_URL must be an absolute http(s) URL",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** True when the Google service-account variables needed for the demo check are present. */
export function googleCalendarConfigured(env: Env): boolean {
  return Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY);
}

export function csvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The domain the service account may impersonate. Callers hand us an AE
 * address; without this guard SuperFlow could ask us to read any mailbox
 * Google would let the delegation reach.
 */
export function impersonationDomain(env: Env): string {
  return env.GOOGLE_IMPERSONATED_USER.split("@")[1]?.toLowerCase() ?? "";
}

/** Agent tool identifiers the pre-dial gate insists on. */
export function requiredAgentTools(env: Env): string[] {
  return csvList(env.LYZR_REQUIRED_AGENT_TOOLS);
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${details}`);
  }
  return result.data;
}

let cached: Env | undefined;

export function getEnv(): Env {
  if (!cached) cached = parseEnv();
  return cached;
}

/** Test-only escape hatch so suites can install a synthetic environment. */
export function setEnvForTesting(env: Env | undefined): void {
  cached = env;
}

/** Derives the wss:// media-stream URL from PUBLIC_BASE_URL. */
export function mediaStreamUrl(env: Env): string {
  const base = env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`;
  return `${base.replace(/\/+$/, "").replace(/^http:/, "ws:").replace(/^https:/, "wss:")}/twilio-media`;
}
