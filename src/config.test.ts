import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, requireEnv } from './config.ts';

test('returns the requested values when all are set', () => {
  const env = { INTAKE_SECRET: 's3cret', OTHER: 'ignored' };
  assert.deepEqual(requireEnv(env, ['INTAKE_SECRET']), { INTAKE_SECRET: 's3cret' });
});

test('names every missing variable in one error', () => {
  const env = { INTAKE_SECRET: 's3cret' };
  assert.throws(
    () => requireEnv(env, ['INTAKE_SECRET', 'VELOO_BASE_URL', 'VELOO_PASSWORD']),
    (error: unknown) =>
      error instanceof ConfigError &&
      error.message.includes('VELOO_BASE_URL') &&
      error.message.includes('VELOO_PASSWORD') &&
      !error.message.includes('INTAKE_SECRET'),
  );
});

test('treats an empty string as missing', () => {
  assert.throws(() => requireEnv({ INTAKE_SECRET: '' }, ['INTAKE_SECRET']), ConfigError);
});
