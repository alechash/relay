export type ErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "validation_error"
  | "not_configured"
  | "internal_error";

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_error: 422,
  not_configured: 503,
  internal_error: 500,
};

export class ApiError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.status = STATUS[code];
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}

export const notFound = (what: string, id: string) => new ApiError("not_found", `${what} '${id}' not found`);
export const conflict = (message: string, details?: unknown) => new ApiError("conflict", message, details);
export const badRequest = (message: string, details?: unknown) => new ApiError("bad_request", message, details);
export const forbidden = (message: string) => new ApiError("forbidden", message);
