// platform/config — CAP-001 stub.
// Parses env into a typed shape. Real parser lands with CAP-005.
import type { EnvironmentName, SharedConfig } from '@unimailbox/config';
import type { Env } from './env';

const ALLOWED_ENVIRONMENTS: ReadonlyArray<EnvironmentName> = [
  'local',
  'preview',
  'staging',
  'production',
];

export interface PlatformConfig extends SharedConfig {
  readonly environment: EnvironmentName;
}

export function loadConfig(env: Env): PlatformConfig {
  const raw = env.ENVIRONMENT ?? 'local';
  const environment: EnvironmentName = ALLOWED_ENVIRONMENTS.includes(
    raw as EnvironmentName,
  )
    ? (raw as EnvironmentName)
    : 'local';
  return { environment, runtime: 'workerd' };
}