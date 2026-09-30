export type ErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "conflict" | "internal";

const statusFor: Record<ErrorCode, 400 | 401 | 403 | 404 | 409 | 500> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

/** Domain error thrown by services; mapped to `{ error: { code, message } }` by the HTTP layer and to a tool error by MCP. */
export class ApiError extends Error {
  readonly status: 400 | 401 | 403 | 404 | 409 | 500;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = statusFor[code];
  }
}

export const badRequest = (message: string) => new ApiError("bad_request", message);
export const unauthorized = (message = "Authentication required") => new ApiError("unauthorized", message);
export const forbidden = (message = "You do not have access to this resource") => new ApiError("forbidden", message);
export const notFound = (what: string) => new ApiError("not_found", `${what} not found`);
export const conflict = (message: string) => new ApiError("conflict", message);

export function errorBody(code: ErrorCode, message: string) {
  return { error: { code, message } };
}
