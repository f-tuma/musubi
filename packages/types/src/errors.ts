export type AppError =
  | BadRequestError
  | UnauthorizedError
  | ForbiddenError
  | NotFoundError;

export class BadRequestError extends Error {
  readonly kind: string = "BadRequest";
  constructor(message: string) {
    super(message);
  }
}

export class UnauthorizedError extends Error {
  readonly kind: string = "Unauthorized";
  constructor(message: string) {
    super(message);
  }
}

export class ForbiddenError extends Error {
  readonly kind: string = "Forbidden";
  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  readonly kind: string = "NotFound";
  constructor(message: string) {
    super(message);
  }
}
