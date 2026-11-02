// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import {
  operationalErrorCode,
  operationalErrorClass,
} from './operational-error.js';
describe('secret-free operational categories', () => {
  it.each([
    ['28P01', 'db_auth_failed'],
    ['28000', 'db_auth_failed'],
    ['08006', 'db_unreachable'],
    ['08001', 'db_unreachable'],
    ['ECONNREFUSED', 'db_unreachable'],
    ['ENOTFOUND', 'db_unreachable'],
    ['EAI_AGAIN', 'db_unreachable'],
    ['ETIMEDOUT', 'db_unreachable'],
    ['42P01', 'migration_pending'],
    ['42703', 'migration_pending'],
    ['unknown-secret-value', 'worker_failed'],
  ])('%s → %s without error details', (code, expected) => {
    const error = Object.assign(new Error('postgres://user:SECRET@host/db'), {
      code,
      stack: 'SECRET',
      detail: 'SECRET',
      query: 'SECRET',
    });
    const log = JSON.stringify({
      event: 'recurring.worker.start',
      outcome: 'error',
      code: operationalErrorCode(error, 'worker_failed'),
    });
    expect(JSON.parse(log).code).toBe(expected);
    expect(log).not.toMatch(/SECRET|postgres:|unknown-secret/);
    expect(
      operationalErrorCode(new Error('outer', { cause: error }), 'app_failed'),
    ).toBe(expected === 'worker_failed' ? 'app_failed' : expected);
  });
  it('handles cycles, primitive errors and explicit configuration failure safely', () => {
    const e: { cause?: unknown } = {};
    e.cause = e;
    expect(operationalErrorCode(e, 'worker_failed')).toBe('worker_failed');
    expect(operationalErrorCode('SECRET', 'config_invalid')).toBe(
      'config_invalid',
    );
  });
});

it('logs a safe built-in error class without exposing custom names or messages', () => {
  const secret = 'SYNTHETIC_SECRET_DO_NOT_LOG';
  const error = new TypeError(secret);
  error.name = secret;
  expect(operationalErrorClass(error)).toBe('TypeError');
  class PrivateError extends Error {}
  expect(operationalErrorClass(new PrivateError(secret))).toBe('Error');
  expect(operationalErrorClass({ name: secret, message: secret })).toBe(
    'UnknownError',
  );
  expect(operationalErrorClass(new RangeError(secret))).toBe('RangeError');
  expect(operationalErrorClass(new SyntaxError(secret))).toBe('SyntaxError');
});
