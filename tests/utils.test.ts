import { describe, expect, it, vi } from "vitest";
import { backoffDelay, isTransientHttpError, retry } from "../src/utils/retry.js";
import { TimeoutError, withTimeout } from "../src/utils/timeout.js";
import { maskEmail, maskPhone, maskSecret } from "../src/utils/logging.js";
import { AppError, ValidationError, toAppError } from "../src/utils/errors.js";

const noSleep = async () => undefined;

describe("retry", () => {
  it("returns the first successful result without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await retry(fn, { sleepFn: noSleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries transient failures then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 503 }))
      .mockResolvedValue("ok");

    expect(await retry(fn, { sleepFn: noSleep, isRetryable: isTransientHttpError })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-transient failure", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("bad request"), { statusCode: 400 }));
    await expect(retry(fn, { sleepFn: noSleep, isRetryable: isTransientHttpError })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt budget and rethrows the last error", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    await expect(retry(fn, { attempts: 3, sleepFn: noSleep })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially", () => {
    const noJitter = () => 1;
    expect(backoffDelay(1, 100, 10000, noJitter)).toBe(100);
    expect(backoffDelay(2, 100, 10000, noJitter)).toBe(200);
    expect(backoffDelay(3, 100, 10000, noJitter)).toBe(400);
  });

  it("respects the ceiling", () => {
    expect(backoffDelay(20, 100, 5000, () => 1)).toBe(5000);
  });

  it("applies jitter within half the exponential value", () => {
    expect(backoffDelay(3, 100, 10000, () => 0)).toBe(200); // 400 * 0.5
    expect(backoffDelay(3, 100, 10000, () => 1)).toBe(400);
  });
});

describe("isTransientHttpError", () => {
  it.each([500, 502, 503, 429, 408])("treats HTTP %i as transient", (statusCode) => {
    expect(isTransientHttpError(Object.assign(new Error("x"), { statusCode }))).toBe(true);
  });

  it.each([400, 401, 404, 422])("treats HTTP %i as permanent", (statusCode) => {
    expect(isTransientHttpError(Object.assign(new Error("x"), { statusCode }))).toBe(false);
  });

  it("treats network errors as transient", () => {
    expect(isTransientHttpError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientHttpError(new Error("fetch failed"))).toBe(true);
  });
});

describe("withTimeout", () => {
  it("passes through a fast result", async () => {
    expect(await withTimeout(1000, "task", async () => "done")).toBe("done");
  });

  it("throws a TimeoutError and aborts the signal", async () => {
    let aborted = false;
    await expect(
      withTimeout(20, "slow task", async (signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error("should have aborted");
      }),
    ).rejects.toThrow(TimeoutError);
    expect(aborted).toBe(true);
  });

  it("names the operation in the timeout message", async () => {
    await expect(
      withTimeout(10, "lyzr startSession", async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }),
    ).rejects.toThrow(/lyzr startSession timed out after 10ms/);
  });
});

describe("log masking", () => {
  it("masks phone numbers while keeping them recognisable", () => {
    expect(maskPhone("+919999999999")).toBe("+91********99");
    expect(maskPhone(null)).toBeNull();
  });

  it("masks the local part of an email but keeps the domain", () => {
    expect(maskEmail("apoorva@example.com")).toBe("ap*****@example.com");
    expect(maskEmail(null)).toBeNull();
  });

  it("never reveals a secret", () => {
    const secret = "sk-super-secret-value";
    const masked = maskSecret(secret)!;
    expect(masked).not.toContain("super-secret");
    expect(maskSecret("short")).toBe("[REDACTED]");
  });
});

describe("errors", () => {
  it("carries a status code and serialises safely", () => {
    const err = new ValidationError("bad input", { field: "phone" });
    expect(err.statusCode).toBe(400);
    expect(err.toJSON()).toEqual({
      error: { code: "validation_error", message: "bad input", details: { field: "phone" } },
    });
  });

  it("wraps unknown errors as 500 without leaking internals", () => {
    const wrapped = toAppError(new Error("kaboom"));
    expect(wrapped).toBeInstanceOf(AppError);
    expect(wrapped.statusCode).toBe(500);
    expect(wrapped.code).toBe("internal_error");
  });

  it("passes AppErrors through unchanged", () => {
    const original = new ValidationError("x");
    expect(toAppError(original)).toBe(original);
  });
});
