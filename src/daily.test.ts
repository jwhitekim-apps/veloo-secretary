import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from './store.ts';
import { syncCandidates, type Candidate } from './ledger.ts';
import { runDaily, type DailyDeps } from './daily.ts';
import type { MailTriageResult } from './mail.ts';

// 한국 시간 2026-10-08(목) 07:00
const T1 = new Date('2026-10-07T22:00:00Z');
const T2 = new Date('2026-10-08T22:00:00Z');

type VTask = { id: number; name: string; memo: string; priority: string; deadline: string; done: boolean };

function world(opts: { mail?: () => Promise<MailTriageResult> | MailTriageResult; tasks?: Partial<VTask>[]; sendFails?: boolean; veloo?: 'ok' | 'down' } = {}) {
  let clock = T1;
  const store = createMemoryStore(() => clock);
  const sent: string[] = [];
  const state = { sendFails: opts.sendFails ?? false, veloo: opts.veloo ?? 'ok' };
  const tasks: VTask[] = (opts.tasks ?? []).map((t, i) => ({ id: i + 1, name: '', memo: '', priority: 'normal', deadline: '', done: false, ...t }));
  let nextId = 500;
  const veloo = {
    async listTasks() {
      if (state.veloo === 'down') throw new Error('fetch failed');
      return tasks.map((t) => ({ ...t }));
    },
    async createTask(c: Candidate) {
      if (state.veloo === 'down') throw new Error('fetch failed');
      const t: VTask = { id: nextId++, done: false, ...c };
      tasks.push(t);
      return t;
    },
  };
  const make = (over: Partial<DailyDeps> = {}): DailyDeps => ({
    now: clock,
    store,
    veloo,
    kakao: { async send(text) { if (state.sendFails) throw new Error('Kakao send failed -> 500'); sent.push(text); } },
    mail: opts.mail ? async () => opts.mail!() : null,
    sync: (candidates, source) => syncCandidates(candidates, source, { veloo, store }),
    limit: 200,
    ...over,
  });
  return { store, sent, state, tasks, make, setClock(d: Date) { clock = d; } };
}

const triage = (over: Partial<MailTriageResult> = {}): MailTriageResult => ({
  candidates: [], uncertain: [], notImportantIds: [], failures: [], stats: { found: 0, fresh: 0, important: 0 }, ...over,
});
const abstractMail = (): MailTriageResult =>
  triage({
    candidates: [{ mailId: 'm1', subject: '[학회] 초록 마감', tasks: [{ name: '학회 초록 마감', deadline: '2026-11-20', priority: 'high', memo: '23:59' }] }],
    notImportantIds: ['ad1'],
  });

test('a normal morning: the mail becomes a task, is reported, and the report is sent', async () => {
  const w = world({ mail: abstractMail, tasks: [{ name: '랩미팅', deadline: '2026-10-08', memo: '15:00' }, { name: '다른 날', deadline: '2026-10-09' }, { name: '끝난 일', deadline: '2026-10-08', done: true }] });
  const out = await runDaily(w.make());

  assert.equal(out.sent, true);
  const text = w.sent.join('\n');
  assert.match(text, /10\/8\(목\) 아침 보고/);
  assert.match(text, /추가: 학회 초록 마감\(11\/20\)/);
  assert.match(text, /오늘: 랩미팅 15:00/);
  assert.doesNotMatch(text, /다른 날|끝난 일/);
  assert.ok(w.tasks.some((t) => t.memo.includes('[비서:mail:m1#0]')), 'task written to the ledger with the marker');
  assert.equal(await w.store.has('mail-seen', 'm1'), true);
  assert.equal(await w.store.has('mail-seen', 'ad1'), true);
  assert.equal(await w.store.getState('last_report_at'), new Date(T1.getTime() + 1).toISOString());
});

test('a quiet morning still sends a short report', async () => {
  const w = world();
  const out = await runDaily(w.make());
  assert.equal(out.sent, true);
  assert.match(w.sent[0], /오늘 일정 없음/);
});

test('proposals and uncertain items are surfaced as things to confirm', async () => {
  const w = world({ mail: () => triage({ uncertain: ['마감일 불확실: 안내 메일 — 제출'] }), tasks: [{ name: '학회 초록 마감', deadline: '2026-11-18' }] });
  await w.store.record('proposal', 'x', { action: 'update_task', taskId: 1, name: '학회 초록 마감', currentDeadline: '2026-11-18', proposedDeadline: '2026-11-20' }, T1.toISOString());
  await runDaily(w.make());
  const text = w.sent.join('\n');
  assert.match(text, /확인: '학회 초록 마감' 마감 11\/18→11\/20/);
  assert.match(text, /확인: 마감일 불확실: 안내 메일 — 제출/);
});

test('if mail triage crashes, the rest of the report is still sent with the failure on top', async () => {
  const w = world({ mail: () => { throw new Error('Gmail token refresh failed -> 400 invalid_grant'); }, tasks: [{ name: '랩미팅', deadline: '2026-10-08' }] });
  const out = await runDaily(w.make());
  assert.equal(out.sent, true);
  const text = w.sent.join('\n');
  assert.match(text, /⚠ 실패: 메일 선별 실패: Gmail token refresh failed/);
  assert.match(text, /오늘: 랩미팅/);
  assert.ok(text.indexOf('⚠') < text.indexOf('오늘:'));
});

test('when Veloo is down, writes fail visibly and the mail is retried on the next run', async () => {
  const w = world({ mail: abstractMail, veloo: 'down' });
  const out = await runDaily(w.make());
  assert.equal(out.sent, true);
  const text = w.sent.join('\n');
  assert.match(text, /⚠ 실패: 벨루 쓰기 실패: 학회 초록 마감/);
  assert.match(text, /⚠ 실패: 벨루 읽기 실패/);
  assert.equal(await w.store.has('mail-seen', 'm1'), false, 'not marked as seen, so it will be retried');

  // 벨루가 살아난 다음 날: 같은 메일이 다시 처리되어 태스크가 생긴다.
  w.state.veloo = 'ok';
  w.setClock(T2);
  await runDaily(w.make({ now: T2 }));
  assert.ok(w.tasks.some((t) => t.name === '학회 초록 마감'));
  assert.equal(await w.store.has('mail-seen', 'm1'), true);
});

test('a failed send is recorded, the sent-time is not advanced, and the next report recovers everything', async () => {
  const w = world({ mail: abstractMail });
  w.state.sendFails = true;
  const first = await runDaily(w.make());
  assert.equal(first.sent, false);
  assert.match(first.failures.join(' '), /보고 전송 실패: Kakao send failed -> 500/);
  assert.equal(await w.store.getState('last_report_at'), null);

  // 다음 날: 전송이 복구되면, 어제 만든 태스크와 어제의 전송 실패가 함께 보고된다.
  w.state.sendFails = false;
  w.setClock(T2);
  const second = await runDaily(w.make({ now: T2, mail: null }));
  assert.equal(second.sent, true);
  const text = w.sent.join('\n');
  assert.match(text, /추가: 학회 초록 마감\(11\/20\)/);
  assert.match(text, /⚠ 실패: 보고 전송 실패/);
  assert.equal(await w.store.getState('last_report_at'), new Date(T2.getTime() + 1).toISOString());
});

test('after a successful report, the same items are not reported again the next day', async () => {
  const w = world({ mail: abstractMail });
  await runDaily(w.make());
  w.sent.length = 0;
  w.setClock(T2);
  await runDaily(w.make({ now: T2, mail: null }));
  assert.doesNotMatch(w.sent.join('\n'), /추가: 학회 초록 마감/);
});

test('a dry run previews what would be added but writes nothing anywhere and sends nothing', async () => {
  const w = world({ mail: abstractMail, tasks: [{ name: '랩미팅', deadline: '2026-10-08' }] });
  const before = w.tasks.length;
  const out = await runDaily(w.make({ dryRun: true }));

  assert.equal(out.sent, false);
  assert.equal(w.sent.length, 0, 'nothing sent to Kakao');
  assert.equal(w.tasks.length, before, 'nothing written to Veloo');
  assert.match(out.messages.join('\n'), /추가: 학회 초록 마감 \(예정, 저장 안 함\)\(11\/20\)/);
  assert.match(out.messages.join('\n'), /오늘: 랩미팅/);
  for (const kind of ['mail', 'mail-seen', 'intake', 'proposal', 'failure']) {
    assert.equal((await w.store.list(kind, '1970-01-01T00:00:00.000Z')).length, 0, `no ${kind} entries`);
  }
  assert.equal(await w.store.getState('last_report_at'), null);
});

test('a dry run does not record failures either', async () => {
  const w = world({ mail: () => { throw new Error('Gmail token refresh failed -> 400'); } });
  const out = await runDaily(w.make({ dryRun: true }));
  assert.match(out.messages.join('\n'), /⚠ 실패: 메일 선별 실패/);
  assert.equal((await w.store.list('failure', '1970-01-01T00:00:00.000Z')).length, 0);
});

test('several messages are sent in order', async () => {
  const w = world({ tasks: Array.from({ length: 30 }, (_, i) => ({ name: `일정 번호 ${i}`, deadline: '2026-10-08' })) });
  const out = await runDaily(w.make());
  assert.ok(out.messages.length > 1 && out.messages.length <= 3);
  assert.deepEqual(w.sent, out.messages);
  assert.ok(w.sent.every((m) => m.length <= 200));
});

test('notes such as a missing durable store are shown in the report', async () => {
  const w = world();
  await runDaily(w.make({ notes: ['저장소가 설정되지 않아 이력이 유지되지 않아요'] }));
  assert.match(w.sent.join('\n'), /참고: 저장소가 설정되지 않아/);
});
