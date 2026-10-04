import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleIntake } from './intake.ts';

function setup(secret = 's3cret') {
  const calls: unknown[] = [];
  const deps = {
    secret,
    interpret: async (input: unknown) => {
      calls.push(input);
      return { message: 'ok' };
    },
  };
  return { calls, deps };
}

const post = (headers: Record<string, string>, body: string) =>
  new Request('http://localhost/api/intake', { method: 'POST', headers, body });

test('rejects a request without credentials and never reaches interpretation', async () => {
  const { calls, deps } = setup();
  const res = await handleIntake(post({}, JSON.stringify({ text: 'hi' })), deps);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('rejects a wrong secret and never reaches interpretation', async () => {
  const { calls, deps } = setup();
  const res = await handleIntake(
    post({ authorization: 'Bearer wrong' }, JSON.stringify({ text: 'hi' })),
    deps,
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('an empty configured secret never authorizes anything', async () => {
  const { calls, deps } = setup('');
  const res = await handleIntake(post({ authorization: 'Bearer ' }, '{}'), deps);
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('passes the parsed body to interpretation when the secret is correct', async () => {
  const { calls, deps } = setup();
  const res = await handleIntake(
    post({ authorization: 'Bearer s3cret' }, JSON.stringify({ text: '금요일까지 메일 답장' })),
    deps,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: 'ok' });
  assert.deepEqual(calls, [{ text: '금요일까지 메일 답장' }]);
});

test('returns 400 for invalid JSON after authentication', async () => {
  const { calls, deps } = setup();
  const res = await handleIntake(post({ authorization: 'Bearer s3cret' }, 'not json'), deps);
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('?dry=1 reaches interpretation as a dry run, and its absence means a normal run', async () => {
  const seen: boolean[] = [];
  const deps = { secret: 's3cret', interpret: async (_: unknown, o: { dryRun: boolean }) => { seen.push(o.dryRun); return { message: 'ok' }; } };
  const headers = { authorization: 'Bearer s3cret' };
  await handleIntake(new Request('http://localhost/api/intake?dry=1', { method: 'POST', headers, body: '{}' }), deps);
  await handleIntake(new Request('http://localhost/api/intake', { method: 'POST', headers, body: '{}' }), deps);
  await handleIntake(new Request('http://localhost/api/intake?dry=0', { method: 'POST', headers, body: '{}' }), deps);
  assert.deepEqual(seen, [true, false, false]);
});

test('answers 400 when interpretation reports an input error', async () => {
  const deps = { secret: 's3cret', interpret: async () => ({ error: 'text or image is required' }) };
  const res = await handleIntake(post({ authorization: 'Bearer s3cret' }, '{}'), deps);
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'text or image is required' });
});

test('returns 405 for non-POST requests with a correct secret', async () => {
  const { calls, deps } = setup();
  const req = new Request('http://localhost/api/intake', {
    method: 'GET',
    headers: { authorization: 'Bearer s3cret' },
  });
  const res = await handleIntake(req, deps);
  assert.equal(res.status, 405);
  assert.equal(calls.length, 0);
});
