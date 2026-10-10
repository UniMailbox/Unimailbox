import { DomainError } from '../../platform/errors';
import { sqliteTimestamp } from '../../platform/idempotency';

export const QUEUE_DELAY_MAX_SECONDS = 86_400;
const MAX_SCHEDULE_MS = 365 * 86_400_000;

/** UTC storage; the client selects a date in its own local timezone. */
export function validateScheduledAt(value: string, now: Date): string {
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getTime() <= now.getTime() ||
    date.getTime() > now.getTime() + MAX_SCHEDULE_MS
  ) {
    throw new DomainError({
      code: 'INVALID_SCHEDULE_TIME',
      message: 'Choose a future time within one year.',
      httpStatus: 400,
    });
  }
  return sqliteTimestamp(new Date(Math.ceil(date.getTime() / 1000) * 1000));
}

export function scheduleDelaySeconds(scheduledAt: string | null, now: Date): number {
  return scheduledAt === null
    ? 0
    : Math.max(
        0,
        Math.ceil((Date.parse(scheduledAt.replace(' ', 'T') + 'Z') - now.getTime()) / 1000),
      );
}

/** A far-future row becomes eligible for the existing recovery scan within 24h. */
export function scheduleRecoveryAt(scheduledAt: string | null, now: Date): string {
  return sqliteTimestamp(
    new Date(
      Math.max(
        now.getTime(),
        scheduledAt === null
          ? 0
          : Date.parse(scheduledAt.replace(' ', 'T') + 'Z') - QUEUE_DELAY_MAX_SECONDS * 1000,
      ),
    ),
  );
}
