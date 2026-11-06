export class ConflictError extends Error {
  override name = "ConflictError";
}

/** A repair refusal the owner must read; its text holds no financial facts. */
export class RepairRefusedError extends ConflictError {
  override name = "RepairRefusedError";
}

export class NotFoundError extends Error {
  override name = "NotFoundError";
}

/** Well-formed input that contradicts stored state, such as an inconsistent scope. */
export class InvalidInputError extends Error {
  override name = "InvalidInputError";
}
