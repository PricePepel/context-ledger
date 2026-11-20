/** A request the user can fix: reported as HTTP 400 with its message. */
export class InputError extends Error {}

/** A request refused by the stored state: reported as HTTP 409 with its message and details. */
export class ConflictError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}
