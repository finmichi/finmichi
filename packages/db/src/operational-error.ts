// SPDX-License-Identifier: AGPL-3.0-only
/** Only allowlisted categories leave the process; never serialize driver errors. */
export type OperationalErrorCode =
  | 'db_auth_failed'
  | 'db_unreachable'
  | 'migration_pending'
  | 'config_invalid'
  | 'worker_failed'
  | 'app_failed';
export function operationalErrorCode(
  error: unknown,
  fallback: OperationalErrorCode,
): OperationalErrorCode {
  const seen = new Set<object>();
  let current = error;
  while (
    typeof current === 'object' &&
    current !== null &&
    !seen.has(current)
  ) {
    seen.add(current);
    const e = current as { code?: unknown; cause?: unknown };
    if (typeof e.code === 'string') {
      if (/^28[A-Z0-9]{3}$/.test(e.code)) return 'db_auth_failed';
      if (
        /^08[A-Z0-9]{3}$/.test(e.code) ||
        [
          'ECONNREFUSED',
          'ENOTFOUND',
          'EHOSTUNREACH',
          'ETIMEDOUT',
          'ECONNRESET',
          'EAI_AGAIN',
          '57P03',
        ].includes(e.code)
      )
        return 'db_unreachable';
      if (['42P01', '42703'].includes(e.code)) return 'migration_pending';
    }
    current = e.cause;
  }
  return fallback;
}

/** Built-in classes only: custom names/messages may contain secrets. */
export function operationalErrorClass(error: unknown): string {
  for (const kind of [
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    URIError,
    EvalError,
    AggregateError,
  ]) {
    if (error instanceof kind) return kind.name;
  }
  return error instanceof Error ? 'Error' : 'UnknownError';
}
