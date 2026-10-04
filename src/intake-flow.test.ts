import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './store.ts';
import { syncCandidates, type Candidate } from './ledger.ts';
import { processIntake } from './intake-flow.ts';
import type { InterpretResult } from './interpret.ts';

type VTask = { id: number; name: string; memo: string; priority: string; deadline: string; done: boolean };

function setup(interpreted: InterpretResult, opts: { veloo?: 'ok' | 'down'; existing?: Partial<VTask>[] } = {}) {
  const store = createMemoryStore();
  const tasks: VTask[] = (opts.existing ?? []).map((t, i) => ({ id: i + 1, name: '', memo: '', priority: 'normal', deadline: '', done: false, ...t }));
  let next = 100;
  const down = opts.veloo === 'down';
  const veloo = {
    async listTasks() { if (down) throw new Error('fetch failed'); return tasks.map((t) => ({ ...t })); },
    async createTask(c: Candidate) { if (down) throw new Error('fetch failed'); const t: VTask = { id: next++, done: false, ...c }; tasks.push(t); return t; },
  };
  let n = 0;
  const deps = {
    interpret: async () => interpreted,
    sync: (c: Candidate[], s: { kind: string; id: string }) => syncCandidates(c, s, { veloo, store }),
    store,
    newId: () => `req${++n}`,
  };
  return { deps, store, tasks };
}

const ok = (over: Partial<Extract<InterpretResult, { message: string }>> = {}): InterpretResult => ({
  message: 'ignored', tasks: [{ name: '랩미팅', deadline: '2026-10-13', priority: 'normal', memo: '15:00' }], assumptions: [], unreadable: [], transcript: '', ...over,
});

test('the task is written to Veloo and the reply says what was added', async () => {
  const { deps, tasks } = setup(ok());
  const result = await processIntake({ text: 'x' }, deps);
  assert.ok('message' in result);
  assert.match(result.message, /^추가했어요 1건: 랩미팅\(10\/13, 15:00\)\./);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].memo, /\[비서:intake:req1#0\]/);
});

test('assumptions and unreadable parts are appended to the reply', async () => {
  const { deps } = setup(ok({ assumptions: ['날짜 언급 없음 → 마감 없음'], unreadable: ['아래쪽이 가려짐'] }));
  const result = await processIntake({ image: 'QUJD' }, deps);
  assert.ok('message' in result);
  assert.match(result.message, /추정: 날짜 언급 없음 → 마감 없음\./);
  assert.match(result.message, /읽을 수 없음: 아래쪽이 가려짐\./);
});

test('an input error from interpretation is passed through untouched', async () => {
  const { deps, tasks } = setup({ error: 'text or image is required' });
  assert.deepEqual(await processIntake({}, deps), { error: 'text or image is required' });
  assert.equal(tasks.length, 0);
});

test('when nothing schedule-like is found, nothing is written', async () => {
  const { deps, tasks } = setup({ message: '일정을 찾지 못했어요.', tasks: [], assumptions: [], unreadable: [], transcript: '' });
  const result = await processIntake({ text: '안녕' }, deps);
  assert.deepEqual(result, { message: '일정을 찾지 못했어요.' });
  assert.equal(tasks.length, 0);
});

test('when Veloo is down the reply still shows the recognized schedule and says it was not saved', async () => {
  const { deps, store } = setup(ok(), { veloo: 'down' });
  const result = await processIntake({ text: 'x' }, deps);
  assert.ok('message' in result);
  assert.match(result.message, /벨루에 저장하지 못했어요\(fetch failed\): 랩미팅\(10\/13, 15:00\)\. 직접 추가해 주세요\./);
  const failures = await store.list('failure', '1970-01-01T00:00:00.000Z');
  assert.equal(failures.length, 1, 'the failure is kept so the next morning report shows it');
  assert.match((failures[0].data as { message: string }).message, /입력 저장 실패: 랩미팅/);
});

test('a similar user-written task turns the reply into a proposal note instead of a duplicate', async () => {
  const { deps, tasks } = setup(ok(), { existing: [{ name: '랩미팅', deadline: '2026-10-12' }] });
  const result = await processIntake({ text: 'x' }, deps);
  assert.ok('message' in result);
  assert.match(result.message, /수정은 제안으로만 남겼어요: 랩미팅/);
  assert.equal(tasks.length, 1, 'no duplicate created');
});

test('sending the same sentence twice (a retry) creates one task and the second reply says it already exists', async () => {
  const { deps, tasks } = setup(ok());
  const first = await processIntake({ text: 'x' }, deps);
  const second = await processIntake({ text: 'x' }, deps);
  assert.equal(tasks.length, 1);
  assert.ok('message' in first && 'message' in second);
  assert.match(first.message, /^추가했어요 1건/);
  assert.match(second.message, /이미 있는 일정: 랩미팅\(10\/13, 15:00\)/);
});

test('a dry run shows the interpretation but writes nothing to Veloo or the history', async () => {
  const { deps, store, tasks } = setup(ok({ message: '인식한 일정 1건: 랩미팅(10/13, 15:00).' }));
  const result = await processIntake({ text: 'x' }, deps, { dryRun: true });
  assert.ok('message' in result);
  assert.equal(result.message, '[시험: 저장 안 함] 인식한 일정 1건: 랩미팅(10/13, 15:00).');
  assert.equal(tasks.length, 0);
  assert.equal((await store.list('intake', '1970-01-01T00:00:00.000Z')).length, 0);
});

test('the reply to a photo includes what was read from it', async () => {
  const { deps } = setup(ok({ transcript: '다른 논문들 더 찾아보기' }));
  const result = await processIntake({ image: 'QUJD' }, deps);
  assert.ok('message' in result);
  assert.match(result.message, /^추가했어요 1건/);
  assert.match(result.message, / 읽은 내용: "다른 논문들 더 찾아보기"\.$/);
});
