/**
 * The protocol generation (ADR-055). It lives in its own file because both sides read
 * it and neither should have to import the other to find it.
 *
 * Bump it when a method, a params object, or a notification's *envelope* changes in a
 * way an older peer would misread. Additive body changes do not need a bump: the event
 * body is passed through unvalidated by design (see `notifications.ts`).
 */
export const PROTOCOL_VERSION = 1;
