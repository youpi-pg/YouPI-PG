import { isValidTransition, isTerminalStatus, VALID_TRANSITIONS, IMMUTABLE_STATES } from '@youpi/common';

/**
 * The transition graph and helpers live in `@youpi/common` so the database layer can enforce
 * them too (`@youpi/db` cannot import `@youpi/core`). They are re-exported here to keep
 * `@youpi/core` the canonical import site for engine consumers.
 */
export { VALID_TRANSITIONS, isValidTransition, isTerminalStatus, IMMUTABLE_STATES };

/**
 * Asserts a valid transition, throwing a detailed domain error if violated.
 * @param {string} currentState
 * @param {string} nextState
 */
export function assertValidTransition(currentState, nextState) {
  if (!isValidTransition(currentState, nextState)) {
    throw new Error(
      `Illegal payment state transition: Cannot move from '${currentState}' to '${nextState}'.`
    );
  }
}

/**
 * Converts internal payment status to the public contract outcome.
 * Throws if the status is not terminal.
 * @param {string} status
 * @returns {string}
 */
export function toPublicOutcome(status) {
  switch (status) {
    case 'OBSERVED_SUCCESS':
      return 'OBSERVED_SUCCESS';
    case 'RECONCILED':
      return 'RECONCILED';
    case 'MANUAL_REVIEW':
      return 'MANUAL_REVIEW';
    case 'SUCCESS':
      return 'SUCCESS';
    case 'FAILED':
      return 'FAILED';
    case 'EXPIRED':
      return 'EXPIRED';
    case 'CANCELLED':
      return 'CANCELLED';
    default:
      throw new Error(`Status '${status}' is an internal non-terminal state and cannot be mapped to a public outcome.`);
  }
}

/** True when a webhook may be dispatched for this status. */
export function isDispatchableOutcome(status) {
  return isTerminalStatus(status);
}

/** Bank-statement posture carried on webhook payloads. Observer matches are never reconciled. */
export function settlementStateFor(status) {
  switch (status) {
    case 'RECONCILED':
      return 'RECONCILED';
    case 'OBSERVED_SUCCESS':
      return 'NOT_RECONCILED';
    case 'MANUAL_REVIEW':
      return 'MANUAL_REVIEW';
    case 'SUCCESS':
      return 'NOT_BANK_SETTLEMENT';
    default:
      return 'NOT_APPLICABLE';
  }
}