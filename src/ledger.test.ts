import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './store.ts';
import { isAssistantTask, syncCandidates, type Candidate } from './ledger.ts';

type Task = { id: number; name: string; memo: string; priority: string; deadline: string; done: boolean };

// 읽기와 생성만 있는 가짜 벨루. 수정·삭제 메서드가 없으므로 호출하면 곧바로 실패한다.
function fakeVeloo(initial: Partial<Task>[] = []) {
  const tasks: Task[] = initial.map((t, i) => ({
    id: i + 1, name: '', memo: '', priority: 'normal', deadline: '', done: false, ...t,
  }));
  const calls = { create: 0 };
  let nextId = 100;
  let failNames = new Set<string>();
  return {
    tasks,
    calls,
    failOn(...names: string[]) { failNames = new Set(names); },
    veloo: {
      async listTasks() { return tasks.map((t) => ({ ...t })); },
      async createTask(c: Candidate) {
        calls.create += 1;
        if (failNames.has(c.name)) throw new Error('Veloo request failed: POST /todo/api/todos -> 500');
        const task: Task = { id: nextId++, done: false, ...c };
        tasks.push(task);
        return task;
      },
    },
  };
}

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  name: '학회 초록 마감', deadline: '2026-11-20', priority: 'high', memo: '', ...over,
});
const src = { kind: 'mail', id: 'm1' };

test('creates tasks whose memo carries the assistant marker and the source id', async () => {
  const f = fakeVeloo();
  const result = await syncCandidates([cand({ memo: '23:59' })], src, { veloo: f.veloo, store: createMemoryStore() });
  assert.equal(result.created.length, 1);
  const memo = f.tasks[0].memo;
  assert.match(memo, /^23:59\n\[비서:mail:m1#0\]$/);
  assert.equal(isAssistantTask(f.tasks[0]), true);
  assert.equal(f.tasks[0].deadline, '2026-11-20');
});

test('a memo-less candidate still gets the marker', async () => {
  const f = fakeVeloo();
  await syncCandidates([cand()], src, { veloo: f.veloo, store: createMemoryStore() });
  assert.equal(f.tasks[0].memo, '[비서:mail:m1#0]');
});

test('the same source is processed once even when synced twice', async () => {
  const f = fakeVeloo();
  const deps = { veloo: f.veloo, store: createMemoryStore() };
  await syncCandidates([cand()], src, deps);
  const second = await syncCandidates([cand()], src, deps);
  assert.equal(f.calls.create, 1);
  assert.deepEqual(second.skipped.map((s) => s.reason), ['already-processed']);
});

test('a task the user deleted in Veloo is not created again', async () => {
  const f = fakeVeloo();
  const deps = { veloo: f.veloo, store: createMemoryStore() };
  await syncCandidates([cand()], src, deps);
  f.tasks.length = 0; // 사용자가 벨루에서 삭제
  const again = await syncCandidates([cand()], src, deps);
  assert.equal(f.calls.create, 1);
  assert.equal(again.created.length, 0);
});

test('a differing deadline on a user-written task becomes a proposal and nothing is changed', async () => {
  const f = fakeVeloo([{ name: '학회 초록 마감', deadline: '2026-11-18', memo: '내가 적은 메모' }]);
  const store = createMemoryStore();
  const result = await syncCandidates([cand()], src, { veloo: f.veloo, store });

  assert.equal(f.calls.create, 0, 'no duplicate task');
  assert.equal(result.proposed.length, 1);
  assert.deepEqual(f.tasks[0], {
    id: 1, name: '학회 초록 마감', memo: '내가 적은 메모', priority: 'normal', deadline: '2026-11-18', done: false,
  });
  const proposals = await store.list('proposal', '1970-01-01T00:00:00.000Z');
  assert.equal(proposals.length, 1);
  assert.deepEqual(proposals[0].data, {
    action: 'update_task', taskId: 1, name: '학회 초록 마감', currentDeadline: '2026-11-18', proposedDeadline: '2026-11-20',
  });
});

test('a user-written task with the same deadline is left alone without a proposal', async () => {
  const f = fakeVeloo([{ name: '학회 초록 마감', deadline: '2026-11-20' }]);
  const store = createMemoryStore();
  const result = await syncCandidates([cand()], src, { veloo: f.veloo, store });
  assert.deepEqual(result.skipped.map((s) => s.reason), ['exists']);
  assert.equal(result.proposed.length, 0);
  assert.equal((await store.list('proposal', '1970-01-01T00:00:00.000Z')).length, 0);
});

test('finished tasks and earlier assistant tasks are not matched against', async () => {
  const f = fakeVeloo([
    { name: '학회 초록 마감', deadline: '2026-11-18', done: true },
    { name: '학회 초록 마감', deadline: '2026-11-18', memo: '[비서:mail:old#0]' },
  ]);
  const result = await syncCandidates([cand()], src, { veloo: f.veloo, store: createMemoryStore() });
  assert.equal(result.created.length, 1);
  assert.equal(result.proposed.length, 0);
});

test('short names only match when equal, so unrelated tasks are not swallowed', async () => {
  const f = fakeVeloo([{ name: '회의', deadline: '2026-11-01' }]);
  const result = await syncCandidates([cand({ name: '랩 회의 준비' })], src, { veloo: f.veloo, store: createMemoryStore() });
  assert.equal(result.created.length, 1);
});

test('a partial failure reports successes and failures separately, and the failed one is retried next time', async () => {
  const f = fakeVeloo();
  const store = createMemoryStore();
  f.failOn('B');
  const first = await syncCandidates([cand({ name: 'A' }), cand({ name: 'B' }), cand({ name: 'C' })], src, { veloo: f.veloo, store });
  assert.deepEqual(first.created.map((c) => c.candidate.name), ['A', 'C']);
  assert.equal(first.failed.length, 1);
  assert.equal(first.failed[0].candidate.name, 'B');
  assert.match(first.failed[0].error, /500/);

  f.failOn();
  const second = await syncCandidates([cand({ name: 'A' }), cand({ name: 'B' }), cand({ name: 'C' })], src, { veloo: f.veloo, store });
  assert.deepEqual(second.created.map((c) => c.candidate.name), ['B']);
  assert.equal(f.tasks.filter((t) => t.name === 'A').length, 1);
});

test('if Veloo cannot be read, every candidate is reported as failed and nothing is created', async () => {
  const store = createMemoryStore();
  const veloo = {
    async listTasks(): Promise<Task[]> { throw new Error('fetch failed'); },
    async createTask(): Promise<Task> { throw new Error('should not be called'); },
  };
  const result = await syncCandidates([cand({ name: 'A' }), cand({ name: 'B' })], src, { veloo, store });
  assert.equal(result.failed.length, 2);
  assert.equal(result.created.length, 0);
  assert.equal(await store.has('mail', 'm1#0'), false);
});

test('no candidates means no calls at all', async () => {
  let called = false;
  const veloo = { async listTasks() { called = true; return []; }, async createTask(): Promise<Task> { throw new Error('x'); } };
  const result = await syncCandidates([], src, { veloo, store: createMemoryStore() });
  assert.equal(called, false);
  assert.equal(result.created.length + result.failed.length, 0);
});

test('a history write failure after creating is surfaced as a warning, not as a failure', async () => {
  const f = fakeVeloo();
  const store = {
    async has() { return false; },
    async record(): Promise<boolean> { throw new Error('db down'); },
  };
  const result = await syncCandidates([cand()], src, { veloo: f.veloo, store });
  assert.equal(result.created.length, 1);
  assert.equal(result.failed.length, 0);
  assert.match(result.warnings[0], /처리 이력을 저장하지 못함/);
});

test('without any processing history, a Veloo task that already carries the source marker blocks a duplicate', async () => {
  const f = fakeVeloo();
  await syncCandidates([cand()], src, { veloo: f.veloo, store: createMemoryStore() });
  // 저장소가 새로 비어 있는 상황(예: 서버리스 호출이 바뀜)에서 같은 메일을 다시 처리한다.
  const again = await syncCandidates([cand()], src, { veloo: f.veloo, store: createMemoryStore() });
  assert.equal(f.calls.create, 1);
  assert.deepEqual(again.skipped.map((s) => s.reason), ['already-processed']);
});

test('re-sending the same input (e.g. after a shortcut error) does not create a second identical task', async () => {
  const f = fakeVeloo();
  const store = createMemoryStore();
  await syncCandidates([cand({ name: '당근 택배 수거', deadline: '2026-10-06' })], { kind: 'intake', id: 'req1' }, { veloo: f.veloo, store });
  const retry = await syncCandidates([cand({ name: '당근 택배 수거', deadline: '2026-10-06' })], { kind: 'intake', id: 'req2' }, { veloo: f.veloo, store });
  assert.equal(f.calls.create, 1);
  assert.deepEqual(retry.skipped.map((s) => s.reason), ['exists']);
  assert.equal(retry.created.length, 0);
});

test('the same name with a different deadline is a different event and is created', async () => {
  const f = fakeVeloo();
  const store = createMemoryStore();
  await syncCandidates([cand({ name: '랩미팅', deadline: '2026-10-06' })], { kind: 'intake', id: 'req1' }, { veloo: f.veloo, store });
  await syncCandidates([cand({ name: '랩미팅', deadline: '2026-10-13' })], { kind: 'intake', id: 'req2' }, { veloo: f.veloo, store });
  assert.equal(f.calls.create, 2);
});

test('a finished assistant task does not block creating the same task again', async () => {
  const f = fakeVeloo([{ name: '당근 택배 수거', deadline: '2026-10-06', memo: '[비서:intake:old#0]', done: true }]);
  const result = await syncCandidates([cand({ name: '당근 택배 수거', deadline: '2026-10-06' })], { kind: 'intake', id: 'req2' }, { veloo: f.veloo, store: createMemoryStore() });
  assert.equal(result.created.length, 1);
});
