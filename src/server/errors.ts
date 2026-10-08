// Errors with a message meant for the person (or agent) who made the request. Anything
// else that escapes a handler is a bug: it is logged with its stack and reported as an
// internal error, still with its message, so the caller can quote it.

export type UserErrorCode =
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "PRECONDITION_FAILED"
  | "FORBIDDEN"
  | "TOO_MANY_REQUESTS";

export class UserError extends Error {
  readonly code: UserErrorCode;

  constructor(message: string, code: UserErrorCode = "BAD_REQUEST") {
    super(message);
    this.name = "UserError";
    this.code = code;
  }
}

export function notFound(what: string): UserError {
  return new UserError(`${what} not found`, "NOT_FOUND");
}
