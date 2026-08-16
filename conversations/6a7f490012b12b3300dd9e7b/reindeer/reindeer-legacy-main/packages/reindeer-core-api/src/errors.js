export class LegacyError extends Error {
  constructor(message, code, status = 400, details = null) {
    super(message);
    this.name = 'LegacyError';
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
  new LegacyError(
    typeof details === 'string' ? details : 'The item could not be saved as entered.',
    'VALIDATION', 400, details,
  );

export const NotFoundError = (what) =>
  new LegacyError(`${what} was not found.`, 'NOT_FOUND', 404);

export const ScopeViolationError = () =>
  new LegacyError('That record belongs to a different inventory.', 'SCOPE_VIOLATION', 403);

export const PermissionError = (action) =>
  new LegacyError(`You do not have permission to ${action}.`, 'PERMISSION', 403);

export const RoundLockedError = () =>
  new LegacyError(
    'The division has already started, so new items are queued for review instead of entering the current round.',
    'ROUND_LOCKED', 409,
  );

export const ExchangeVersionError = (found) =>
  new LegacyError(
    `This file uses exchange format ${found}, which this version cannot read.`,
    'EXCHANGE_VERSION', 422,
  );
