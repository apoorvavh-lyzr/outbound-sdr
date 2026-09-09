import { sleep } from "./timeout.js";

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Only retry when this returns true. Defaults to retrying everything. */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  /** Injectable for deterministic tests. */
  random?: () => number;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Exponential backoff with full jitter. */
export function backoffDelay(attempt: number, baseDelayMs: number, maxDelayMs: number, random = Math.random): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}

export async function retry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 250,
    maxDelayMs = 4000,
    isRetryable = () => true,
    onRetry,
    random = Math.random,
    sleepFn = sleep,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === attempts || !isRetryable(err)) break;
      const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs, random);
      onRetry?.(err, attempt, delay);
      await sleepFn(delay);
    }
  }
  throw lastError;
}

/** Network blips and 5xx/429 are transient; 4xx is not. */
export function isTransientHttpError(err: unknown): boolean {
  if (err && typeof err === "object" && "statusCode" in err) {
    const status = Number((err as { statusCode: unknown }).statusCode);
    if (Number.isFinite(status)) return status === 408 || status === 429 || status >= 500;
  }
  if (err instanceof Error) {
    return /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|socket hang up|fetch failed|network/i.test(
      err.message,
    );
  }
  return false;
}
