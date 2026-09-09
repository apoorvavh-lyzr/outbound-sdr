import { AppError } from "./errors.js";

export class TimeoutError extends AppError {
  constructor(message: string) {
    super("timeout", message, 504);
  }
}

/**
 * Runs `fn` with an AbortSignal that fires after `ms`.
 *
 * The result is RACED against the deadline rather than merely passing the
 * signal down: a callee that ignores its signal (or swallows the abort) would
 * otherwise hang forever. Whichever settles first wins, and the timer is always
 * cleared so a resolved promise never keeps the event loop alive.
 */
export async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`${label} timed out after ${ms}ms`));
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), deadline]);
  } catch (err) {
    // Normalise an abort surfaced by the callee into the same TimeoutError.
    if (controller.signal.aborted && !(err instanceof TimeoutError)) {
      throw new TimeoutError(`${label} timed out after ${ms}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
