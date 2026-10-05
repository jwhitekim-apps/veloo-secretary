import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../adapters/store.ts';
import { buildQuery, triageMail, type MailDeps } from './mail.ts';

const meta = (id: string, subject: string) => ({ id, subject, from: `${id}@x.test`, date: 'Mon, 5 Oct 2026', snippet: `${subject} 요약` });

function setup(over: Partial<MailDeps> & { metas?: ReturnType<typeof meta>[]; verdicts?: Record<string, boolean>; interpreted?: Record<string, unknown> } = {}) {
  const calls = { search: [] as string[], body: [] as string[], judge: [] as string[], interpret: [] as string[] };
  const store = createMemoryStore();
  const metas = over.metas ?? [meta('a', '[학회] 초록 마감'), meta('b', '교수님 연구실 광고')];
  const deps: MailDeps = {
    gmail: {
      async search(q) { calls.search.push(q); return metas; },
      async readBody(id) { calls.body.push(id); return `본문 ${id}`; },
    },
    async generateJson({ prompt }) {
      calls.judge.push(prompt);
      return { items: metas.map((m) => ({ id: m.id, important: over.verdicts?.[m.id] ?? m.id === 'a', reason: 'r' })) };
    },
    async interpret(text) {
      calls.interpret.push(text);
      const id = text.match(/본문 (\w+)/)?.[1] ?? '';
      return (over.interpreted?.[id] as never) ?? { tasks: [{ name: '초록 제출', deadline: '2026-11-20', priority: 'high', memo: '23:59' }], assumptions: [], unreadable: [] };
    },
    store,
    keywords: ['학회', '교수'],
    lookbackDays: 1,
    ...over,
  };
  return { deps, calls, store };
}

test('buildQuery limits the window and ORs the quoted keywords', () => {
  assert.equal(buildQuery(['학회', ' 교수 ', ''], 1), 'newer_than:1d ("학회" OR "교수")');
  assert.equal(buildQuery(['a"b'], 3), 'newer_than:3d ("ab")');
});

test('no keywords is a configuration error, not an unfiltered mailbox scan', () => {
  assert.throws(() => buildQuery([' ', ''], 1), /No mail keywords/);
});

test('the first pass sees only subject, sender and snippet; bodies are read for important mails only', async () => {
  const { deps, calls } = setup();
  const result = await triageMail(deps);
  assert.match(calls.judge[0], /\[학회\] 초록 마감/);
  assert.doesNotMatch(calls.judge[0], /본문 /, 'no body in the first pass');
  assert.deepEqual(calls.body, ['a'], 'the unimportant mail body is never read');
  assert.deepEqual(result.notImportantIds, ['b']);
});

test('an important mail with a clear deadline becomes a candidate carrying its mail id', async () => {
  const { deps } = setup();
  const result = await triageMail(deps);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].mailId, 'a');
  assert.deepEqual(result.candidates[0].tasks[0], { name: '초록 제출', deadline: '2026-11-20', priority: 'high', memo: '23:59' });
  assert.deepEqual(result.stats, { found: 2, fresh: 2, important: 1 });
});

test('the interpreter receives the subject, sender and body', async () => {
  const { deps, calls } = setup();
  await triageMail(deps);
  assert.match(calls.interpret[0], /메일 제목: \[학회\] 초록 마감/);
  assert.match(calls.interpret[0], /보낸 사람: a@x\.test/);
  assert.match(calls.interpret[0], /본문 a/);
});

test('an unclear deadline is flagged for confirmation, not guessed and not turned into a task', async () => {
  const { deps } = setup({
    interpreted: { a: { tasks: [{ name: '초록 제출', deadline: '', priority: 'normal', memo: '' }], assumptions: ['날짜 언급 없음'], unreadable: [] } },
  });
  const result = await triageMail(deps);
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.uncertain, ['마감일 불확실: [학회] 초록 마감 — 초록 제출']);
});

test('unreadable parts of a mail are reported as items to check', async () => {
  const { deps } = setup({
    interpreted: { a: { tasks: [], assumptions: [], unreadable: ['표의 날짜가 이미지라 읽을 수 없음'] } },
  });
  const result = await triageMail(deps);
  assert.match(result.uncertain[0], /표의 날짜가 이미지라 읽을 수 없음/);
});

test('mails already seen are not judged again on a second run', async () => {
  const { deps, calls, store } = setup();
  await store.record('mail-seen', 'a', {});
  await store.record('mail-seen', 'b', {});
  const result = await triageMail(deps);
  assert.equal(calls.judge.length, 0, 'the model is not called when nothing is new');
  assert.deepEqual(result.stats, { found: 2, fresh: 0, important: 0 });
});

test('a mail the judge forgot to mention is treated as important rather than silently dropped', async () => {
  const { deps, calls } = setup();
  deps.generateJson = async () => ({ items: [{ id: 'b', important: false, reason: 'ad' }] });
  const result = await triageMail(deps);
  assert.deepEqual(calls.body, ['a']);
  assert.equal(result.candidates.length, 1);
});

test('a malformed judge response fails loudly', async () => {
  const { deps } = setup();
  deps.generateJson = async () => ({ nope: true });
  await assert.rejects(triageMail(deps), /invalid structure/);
});

test('one failing mail is reported while the others are still processed, and it is not marked as seen', async () => {
  const metas = [meta('a', '첫째'), meta('c', '셋째')];
  const { deps } = setup({ metas, verdicts: { a: true, c: true } });
  const original = deps.gmail.readBody;
  deps.gmail.readBody = async (id) => { if (id === 'a') throw new Error('Gmail request failed -> 500'); return original(id); };
  const result = await triageMail(deps);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0], /첫째/);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].mailId, 'c');
  assert.ok(!result.notImportantIds.includes('a'), 'failed mail will be retried next run');
});

test('when nothing matches the keywords the model is never called', async () => {
  const { deps, calls } = setup({ metas: [] });
  const result = await triageMail(deps);
  assert.equal(calls.judge.length, 0);
  assert.deepEqual(result.stats, { found: 0, fresh: 0, important: 0 });
});
