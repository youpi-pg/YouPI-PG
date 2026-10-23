import { PaymentStatus } from './enums.js';

/**
 * Allowed payment session state transitions.
 *
 * This lives in `@youpi/common` rather than `@youpi/core` because the database layer
 * (`@youpi/db`) must enforce it too, and `@youpi/db` cannot depend on `@youpi/core`
 * (which already depends on it). `@youpi/core` re-exports these helpers unchanged.
 */
export const VALID_TRANSITIONS = Object.freeze({
  // EXPIRED is reachable from every non-terminal state: it is the universal "gave up"
  // outcome (timer elapsed, or an administrator clearing the queue), so it must never be
  // blocked just because the session had not reached the next stage yet.
  [PaymentStatus.INITIATED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.QUEUED,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED,
    PaymentStatus.MANUAL_REVIEW,
    // COD: placing a Cash-on-Delivery order is a business success even before any UPI
    // slot is acquired, so an order that was never activated still terminates as SUCCESS.
    PaymentStatus.SUCCESS
  ],
  [PaymentStatus.QUEUED]: [
    PaymentStatus.ACTIVE,
    PaymentStatus.CANCELLED,
    PaymentStatus.EXPIRED,
    PaymentStatus.MANUAL_REVIEW,
    // COD: a queued UPI order can be converted to a placed COD order.
    PaymentStatus.SUCCESS
  ],
  [PaymentStatus.ACTIVE]: [
    PaymentStatus.PROCESSING,
    // Observer match. Not a bank-statement confirmation.
    PaymentStatus.OBSERVED_SUCCESS,
    PaymentStatus.MANUAL_REVIEW,
    // COD / cashier confirmation only. UPI alert code must not use SUCCESS.
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED,
    PaymentStatus.CANCELLED
  ],
  [PaymentStatus.PROCESSING]: [
    PaymentStatus.OBSERVED_SUCCESS,
    PaymentStatus.MANUAL_REVIEW,
    PaymentStatus.SUCCESS,
    PaymentStatus.FAILED,
    PaymentStatus.EXPIRED
  ],
  [PaymentStatus.OBSERVED_SUCCESS]: [
    PaymentStatus.RECONCILED,
    PaymentStatus.MANUAL_REVIEW
  ],
  [PaymentStatus.MANUAL_REVIEW]: [
    PaymentStatus.RECONCILED
  ],
  [PaymentStatus.RECONCILED]: [],
  [PaymentStatus.SUCCESS]: [],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.EXPIRED]: [],
  [PaymentStatus.CANCELLED]: []
});

/** Slot-releasing outcomes. OBSERVED_SUCCESS is not bank settlement. */
export const SLOT_RELEASE_STATES = Object.freeze([
  PaymentStatus.OBSERVED_SUCCESS,
  PaymentStatus.RECONCILED,
  PaymentStatus.MANUAL_REVIEW,
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELLED
]);

/**
 * Public/dispatch outcomes. OBSERVED_SUCCESS and MANUAL_REVIEW are included so webhooks
 * and the queue treat them as closed, but they are not immutable: a future statement
 * match may move them to RECONCILED. No observer path performs that move.
 */
export const TERMINAL_STATES = Object.freeze([
  PaymentStatus.OBSERVED_SUCCESS,
  PaymentStatus.RECONCILED,
  PaymentStatus.MANUAL_REVIEW,
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELLED
]);

/** States that must not change again. */
export const IMMUTABLE_STATES = Object.freeze([
  PaymentStatus.RECONCILED,
  PaymentStatus.SUCCESS,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELLED
]);

/** States that occupy a merchant's single UPI concurrency slot. */
export const SLOT_OCCUPYING_STATES = Object.freeze([
  PaymentStatus.ACTIVE,
  PaymentStatus.PROCESSING
]);

/**
 * Validates whether a state transition is permitted.
 * @param {string} currentState
 * @param {string} nextState
 * @returns {boolean}
 */
export function isValidTransition(currentState, nextState) {
  const allowed = VALID_TRANSITIONS[currentState];
  if (!allowed) return false;
  return allowed.includes(nextState);
}

/** True when the state is a final, terminal outcome. */
export function isTerminalStatus(status) {
  return TERMINAL_STATES.includes(status);
}

/** True when the state holds a merchant concurrency slot. */
export function holdsSlot(status) {
  return SLOT_OCCUPYING_STATES.includes(status);
}