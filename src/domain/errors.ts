export class ConflictError extends Error {
  override name = "ConflictError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** Well-formed input that contradicts stored state, such as an inconsistent scope. */
export class InvalidInputError extends Error {
  override name = "InvalidInputError";
}
