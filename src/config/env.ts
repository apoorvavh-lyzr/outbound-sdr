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
    LYZR_HTTP_TIMEOUT_MS: int(20000, 1000),

    TWILIO_ACCOUNT_SID: optionalStr,
    TWILIO_AUTH_TOKEN: optionalStr,
    TWILIO_PHONE_NUMBER: optionalStr,
    TWILIO_CALL_TIMEOUT_SECONDS: int(45, 5),
    TWILIO_VALIDATE_WEBHOOKS: bool.optional().default(true),

    SUPERFLOW_SHARED_SECRET: optionalStr,
    SUPERFLOW_CALLBACK_URL: optionalStr,
    SUPERFLOW_CALLBACK_SECRET: optionalStr,

    DATABASE_URL: optionalStr,

    AUDIO_PRECONNECT_BUFFER_MS: int(4000, 500),
    CALL_RATE_LIMIT_MAX: int(30, 1),
    CALL_RATE_LIMIT_WINDOW_MS: int(60000, 1000),

    MOCK_EXTERNAL_SERVICES: bool.optional().default(false),
    CLONED_AGENT_RETENTION_HOURS: int(72, 0),
    ENABLE_DNC_CHECK: bool.optional().default(false),
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

    if (env.NODE_ENV === "production") {
      need("DATABASE_URL", env.DATABASE_URL);
      if (env.PUBLIC_BASE_URL && !env.PUBLIC_BASE_URL.startsWith("https://")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PUBLIC_BASE_URL"],
          message: "PUBLIC_BASE_URL must start with https:// so the Twilio Stream URL is wss://",
        });
      }
    }

    if (env.SUPERFLOW_CALLBACK_URL && !/^https?:\/\//.test(env.SUPERFLOW_CALLBACK_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["SUPERFLOW_CALLBACK_URL"],
        message: "SUPERFLOW_CALLBACK_URL must be an absolute http(s) URL",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

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
