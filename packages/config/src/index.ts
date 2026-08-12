/**
 * @unimailbox/config
 *
 * Shared config types — environment names, deployment targets, runtime flags.
 * Pure types only; values come from `apps/worker/src/platform/config.ts`.
 *
 * CAP-001 lays rails — this skeleton declares the shape but no values.
 */

export type EnvironmentName = 'local' | 'preview' | 'staging' | 'production';

export type RuntimeKind = 'node' | 'workerd' | 'browser';

export interface SharedConfig {
  readonly environment: EnvironmentName;
  readonly runtime: RuntimeKind;
}

export {};