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

function asyncDeps(overrides: Record<string, unknown> = {}) {
  const tasks: Promise<unknown>[] = [];
  const notes: string[] = [];
  let releaseInterpret: () => void = () => {};
  const gate = new Promise<void>((resolve) => { releaseInterpret = resolve; });
  const deps = {
    secret: 's3cret',
    interpret: async (_: unknown, o: { dryRun: boolean }) => { await gate; return { message: o.dryRun ? '시험 결과' : '추가했어요 1건: 랩미팅(10/13).' }; },
    validate: (input: unknown) => ((input as { text?: string })?.text ? null : 'text or image is required'),
    runInBackground: (task: Promise<unknown>) => { tasks.push(task); },
    notify: async (text: string) => { notes.push(text); },
    ...overrides,
  };
  return { deps, tasks, notes, release: () => releaseInterpret() };
}

const asyncPost = (query: string, body: unknown) =>
  new Request(`http://localhost/api/intake${query}`, { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify(body) });

test('?async=1 answers 202 right away, before the slow interpretation has finished', async () => {
  const { deps, tasks, notes, release } = asyncDeps();
  const res = await handleIntake(asyncPost('?async=1', { text: 'x' }), deps);
  assert.equal(res.status, 202);
  assert.match(((await res.json()) as { message: string }).message, /접수했어요.*카톡/);
  assert.equal(notes.length, 0, 'nothing has been reported yet');
  release();
  await Promise.all(tasks);
  assert.deepEqual(notes, ['[비서] 추가했어요 1건: 랩미팅(10/13).']);
});

test('?async=1 with ?dry=1 still processes in the background as a dry run', async () => {
  const { deps, tasks, notes, release } = asyncDeps();
  await handleIntake(asyncPost('?async=1&dry=1', { text: 'x' }), deps);
  release();
  await Promise.all(tasks);
  assert.deepEqual(notes, ['[비서] 시험 결과']);
});

test('?async=1 rejects invalid input immediately and never starts background work', async () => {
  const { deps, tasks, notes } = asyncDeps();
  const res = await handleIntake(asyncPost('?async=1', {}), deps);
  assert.equal(res.status, 400);
  assert.equal(tasks.length, 0);
  assert.equal(notes.length, 0);
});

test('?async=1 reports a processing failure through the notification instead of losing it', async () => {
  const { deps, tasks, notes } = asyncDeps({ interpret: async () => { throw new Error('Gemini quota exceeded'); } });
  const res = await handleIntake(asyncPost('?async=1', { text: 'x' }), deps);
  assert.equal(res.status, 202);
  await Promise.all(tasks);
  assert.deepEqual(notes, ['[비서] 처리 실패: Gemini quota exceeded']);
});

test('?async=1 reports an input error from interpretation through the notification', async () => {
  const { deps, tasks, notes, release } = asyncDeps({ interpret: async () => ({ error: 'text or image is required' }) });
  await handleIntake(asyncPost('?async=1', { text: 'x' }), deps);
  release();
  await Promise.all(tasks);
  assert.deepEqual(notes, ['[비서] 입력 오류: text or image is required']);
});

test('a failing notification does not crash the background task', async () => {
  const { deps, tasks, release } = asyncDeps({ notify: async () => { throw new Error('Kakao send failed -> 500'); } });
  await handleIntake(asyncPost('?async=1', { text: 'x' }), deps);
  release();
  await assert.doesNotReject(Promise.all(tasks));
});

test('without background support, ?async=1 falls back to the normal synchronous answer', async () => {
  const { deps, release } = asyncDeps({ runInBackground: undefined });
  release();
  const res = await handleIntake(asyncPost('?async=1', { text: 'x' }), deps);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { message: '추가했어요 1건: 랩미팅(10/13).' });
});

test('authentication is still required for ?async=1', async () => {
  const { deps, tasks } = asyncDeps();
  const res = await handleIntake(new Request('http://localhost/api/intake?async=1', { method: 'POST', body: '{"text":"x"}' }), deps);
  assert.equal(res.status, 401);
  assert.equal(tasks.length, 0);
});
