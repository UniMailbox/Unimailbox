/** Non-secret, attempt-specific provider correlation; never a recipient or subject match. */
export function outboundAttemptTag(attemptId: string): string {
  return `um-attempt:${attemptId}`;
}
export function parseOutboundAttemptTag(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return (
    /^um-attempt:([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/i.exec(
      value,
    )?.[1] ?? null
  );
}
