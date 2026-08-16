export class ReindeerError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'ReindeerError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * Pass a single sentence and it becomes the message the person reads.
 * Pass a list of field errors and the caller gets the generic sentence plus
 * the details, which is what the item form wants.
 */
export const ValidationError = (details) =>
  new ReindeerError(
    typeof details === 'string' ? details : 'The item could not be saved as entered.',
    'VALIDATION', 400, details,
  );

export const NotFoundError = (what) =>
  new ReindeerError(`${what} was not found.`, 'NOT_FOUND', 404);

export const ScopeViolationError = () =>
  new ReindeerError('That record belongs to a different inventory.', 'SCOPE_VIOLATION', 403);

export const PermissionError = (action) =>
  new ReindeerError(`You do not have permission to ${action}.`, 'PERMISSION', 403);

export const RoundLockedError = () =>
  new ReindeerError(
    'The division has already started, so new items are queued for review instead of entering the current round.',
    'ROUND_LOCKED', 409,
  );

export const ExchangeVersionError = (found) =>
  new ReindeerError(
    `This file uses exchange format ${found}, which this version cannot read.`,
    'EXCHANGE_VERSION', 422,
  );
