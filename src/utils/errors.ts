export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, statusCode = 500, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("validation_error", message, 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super("unauthorized", message, 401);
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("not_found", message, 404);
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super("conflict", message, 409);
  }
}

/** An upstream dependency (Lyzr / Twilio) failed. */
export class UpstreamError extends AppError {
  constructor(code: string, message: string, statusCode = 502, details?: unknown) {
    super(code, message, statusCode, details);
  }
}

/** Pre-dial safety gate refused to place the call. */
export class PreflightError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 422, details);
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  const message = err instanceof Error ? err.message : "Unexpected error";
  return new AppError("internal_error", message, 500);
}
