import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBearerAuthorized } from '../../src/http/auth.js';

const req = (authorization?: string) =>
  new Request('http://localhost/x', { headers: authorization ? { authorization } : {} });

test('accepts only the exact bearer secret', () => {
  assert.equal(isBearerAuthorized(req('Bearer s3cret'), 's3cret'), true);
  assert.equal(isBearerAuthorized(req('Bearer s3cret2'), 's3cret'), false);
  assert.equal(isBearerAuthorized(req('Bearer s3cre'), 's3cret'), false);
  assert.equal(isBearerAuthorized(req('bearer s3cret'), 's3cret'), false);
  assert.equal(isBearerAuthorized(req('Bearer wrong'), 's3cret'), false);
  assert.equal(isBearerAuthorized(req('s3cret'), 's3cret'), false);
  assert.equal(isBearerAuthorized(req(), 's3cret'), false);
});

test('an empty secret never authorizes, even for an empty bearer', () => {
  assert.equal(isBearerAuthorized(req('Bearer '), ''), false);
  assert.equal(isBearerAuthorized(req(), ''), false);
});
