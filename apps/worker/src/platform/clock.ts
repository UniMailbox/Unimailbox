// platform/clock — CAP-001 stub.
// Domain code takes a Clock from here so tests can inject fixed values.
// .claude/rules/testing.md §Determinism.
export interface Clock {
  now(): Date;
  unixMs(): number;
}

export const systemClock: Clock = {
  now: (): Date => new Date(),
  unixMs: (): number => Date.now(),
};