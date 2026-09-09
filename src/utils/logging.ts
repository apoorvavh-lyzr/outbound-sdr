import { pino, type Logger } from "pino";

/** Never let these reach a log sink, at any nesting depth. */
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers['x-api-key']",
  "req.headers['x-twilio-signature']",
  "headers.authorization",
  "headers['x-api-key']",
  "*.authorization",
  "*.apiKey",
  "*.api_key",
  "*.LYZR_API_KEY",
  "*.TWILIO_AUTH_TOKEN",
  "*.SUPERFLOW_SHARED_SECRET",
  "*.SUPERFLOW_CALLBACK_SECRET",
  "apiKey",
  "api_key",
  "authToken",
  "auth_token",
  "password",
  "token",
  "secret",
];

let rootLogger: Logger | undefined;

export function createLogger(level = "info"): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    base: { service: "lyzr-outbound-voice" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function getLogger(): Logger {
  if (!rootLogger) rootLogger = createLogger(process.env.LOG_LEVEL ?? "info");
  return rootLogger;
}

export function setLogger(logger: Logger): void {
  rootLogger = logger;
}

/** "+919999999999" -> "+91******99" */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  if (trimmed.length <= 5) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 3)}${"*".repeat(Math.max(0, trimmed.length - 5))}${trimmed.slice(-2)}`;
}

/** "apoorva@example.com" -> "ap*****@example.com" */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf("@");
  if (at <= 0) return "*".repeat(email.length);
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const keep = local.slice(0, Math.min(2, local.length));
  return `${keep}${"*".repeat(Math.max(1, local.length - keep.length))}${domain}`;
}

/** Truncated fingerprint so we can correlate a key without exposing it. */
export function maskSecret(secret: string | null | undefined): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return "[REDACTED]";
  return `${secret.slice(0, 3)}…${secret.slice(-2)} (len=${secret.length})`;
}
