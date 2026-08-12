// platform/logger — structured JSON logger.
// CAP-001 minimal implementation; CAP-016 will harden (correlation IDs,
// redaction, log levels from env). Native console wrapped — pino/consola
// are deliberately deferred per task.md §Decisions.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  readonly [key: string]: unknown;
}

export interface LogFields {
  readonly event: string;
  readonly requestId?: string;
  readonly actorUserId?: string;
  readonly durationMs?: number;
  readonly level?: LogLevel;
}

function emit(level: LogLevel, fields: LogFields, context?: LogContext): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...fields,
    ...(context ?? {}),
  });
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    // CAP-001: keep info/debug on stdout to match the legacy log topology.
    // eslint-disable-next-line no-console -- this IS the logger
    console.info(line);
  }
}

export const logger = {
  debug: (fields: LogFields, context?: LogContext): void =>
    emit('debug', fields, context),
  info: (fields: LogFields, context?: LogContext): void =>
    emit('info', fields, context),
  warn: (fields: LogFields, context?: LogContext): void =>
    emit('warn', fields, context),
  error: (fields: LogFields, context?: LogContext): void =>
    emit('error', fields, context),
} as const;