import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/adapters/store.ts';
import { syncCandidates, type Candidate } from '../../src/domain/ledger.ts';
import { runDaily, type DailyDeps } from '../../src/flows/daily.ts';
import type { MailTriageResult } from '../../src/domain/mail.ts';
import type { Paper } from '../../src/domain/papers.ts';

// 한국 시간 2026-10-08(목) 07:00
const T1 = new Date('2026-10-07T22:00:00Z');
const T2 = new Date('2026-10-08T22:00:00Z');

type VTask = { id: number; name: string; memo: string; priority: string; deadline: string; done: boolean; created_at?: string };

function world(
  opts: {
    mail?: () => Promise<MailTriageResult> | MailTriageResult;
    tasks?: Partial<VTask>[];
    sendFails?: boolean;
    veloo?: 'ok' | 'down';
    weekly?: 'ok' | 'down';
    papers?: Paper[] | 'down';
  } = {},
) {
  let clock = T1;
  const store = createMemoryStore(() => clock);
  const sent: string[] = [];
  const state = { sendFails: opts.sendFails ?? false, veloo: opts.veloo ?? 'ok' };
  const tasks: VTask[] = (opts.tasks ?? []).map((t, i) => ({ id: i + 1, name: '', memo: '', priority: 'normal', deadline: '', done: false, ...t }));
  let nextId = 500;
  const weeklyCalls: string[] = [];
  const veloo = {
    ...(opts.weekly
      ? {
          async weeklyReview(weekStart: string) {
            weeklyCalls.push(weekStart);
            if (opts.weekly === 'down') throw new Error('review failed');
            return { completed: 5, created: 9, overdue: 3 };
          },
        }
      : {}),
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
    folio:
      opts.papers === undefined
        ? null
        : {
            async recentPapers() {
              if (opts.papers === 'down') throw new Error('folio down');
              return opts.papers as Paper[];
            },
          },
    mail: opts.mail ? async () => opts.mail!() : null,
    sync: (candidates, source) => syncCandidates(candidates, source, { veloo, store }),
    limit: 200,
    ...over,
  });
  return { store, sent, state, tasks, weeklyCalls, make, setClock(d: Date) { clock = d; } };
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
  assert.match(text, /\[추가\]\n· 학회 초록 마감\(11\/20\)/);
  assert.match(text, /· 랩미팅 15:00/);
  assert.match(text, /\[먼저 할 일\]\n(?:.*\n)*?\d\) 다른 날 — 1일 남음/, 'a task due tomorrow ranks among the first things to do, with how many days are left');
  assert.doesNotMatch(text, /끝난 일/, 'finished tasks are never listed');
  assert.ok(w.tasks.some((t) => t.name === '학회 초록 마감' && !t.memo.includes('[비서:')), 'task written to the ledger without any internal marker');
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
  assert.match(text, /\[확인\]\n· '학회 초록 마감' 마감 11\/18→11\/20/);
  assert.match(text, /· 마감일 불확실: 안내 메일 — 제출/);
});

test('if mail triage crashes, the rest of the report is still sent with the failure on top', async () => {
  const w = world({ mail: () => { throw new Error('Gmail token refresh failed -> 400 invalid_grant'); }, tasks: [{ name: '랩미팅', deadline: '2026-10-08' }] });
  const out = await runDaily(w.make());
  assert.equal(out.sent, true);
  const text = w.sent.join('\n');
  assert.match(text, /\[⚠ 실패\]\n· 메일 선별 실패: Gmail token refresh failed/);
  assert.match(text, /· 랩미팅/);
  assert.ok(text.indexOf('⚠') < text.indexOf('[오늘]'));
});

test('when Veloo is down, writes fail visibly and the mail is retried on the next run', async () => {
  const w = world({ mail: abstractMail, veloo: 'down' });
  const out = await runDaily(w.make());
  assert.equal(out.sent, true);
  const text = w.sent.join('\n');
  assert.match(text, /\[⚠ 실패\]\n· 벨루 쓰기 실패: 학회 초록 마감/);
  assert.match(text, /· 벨루 읽기 실패/);
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
  assert.match(text, /\[추가\]\n· 학회 초록 마감\(11\/20\)/);
  assert.match(text, /· 보고 전송 실패/);
  assert.equal(await w.store.getState('last_report_at'), new Date(T2.getTime() + 1).toISOString());
});

test('after a successful report, the same items are not reported again the next day', async () => {
  const w = world({ mail: abstractMail });
  await runDaily(w.make());
  w.sent.length = 0;
  w.setClock(T2);
  await runDaily(w.make({ now: T2, mail: null }));
  assert.doesNotMatch(w.sent.join('\n'), /\[추가\]\n· 학회 초록 마감/);
});

test('a dry run previews what would be added but writes nothing anywhere and sends nothing', async () => {
  const w = world({ mail: abstractMail, tasks: [{ name: '랩미팅', deadline: '2026-10-08' }] });
  const before = w.tasks.length;
  const out = await runDaily(w.make({ dryRun: true }));

  assert.equal(out.sent, false);
  assert.equal(w.sent.length, 0, 'nothing sent to Kakao');
  assert.equal(w.tasks.length, before, 'nothing written to Veloo');
  assert.match(out.messages.join('\n'), /\[추가\]\n· 학회 초록 마감 \(예정, 저장 안 함\)\(11\/20\)/);
  assert.match(out.messages.join('\n'), /· 랩미팅/);
  for (const kind of ['mail', 'mail-seen', 'intake', 'proposal', 'failure']) {
    assert.equal((await w.store.list(kind, '1970-01-01T00:00:00.000Z')).length, 0, `no ${kind} entries`);
  }
  assert.equal(await w.store.getState('last_report_at'), null);
});

test('a dry run does not record failures either', async () => {
  const w = world({ mail: () => { throw new Error('Gmail token refresh failed -> 400'); } });
  const out = await runDaily(w.make({ dryRun: true }));
  assert.match(out.messages.join('\n'), /· 메일 선별 실패/);
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
  assert.match(w.sent.join('\n'), /\[참고\]\n· 저장소가 설정되지 않아/);
});

test('open Veloo tasks appear by state; a task the assistant just added is listed once, under "추가" only', async () => {
  const w = world({
    tasks: [
      // 위쪽 세 개는 가장 먼저 할 일(Top 3)로 올라가서 아래 구역에는 되풀이되지 않는다.
      { name: '급한 일 1', priority: 'urgent', deadline: '2026-10-01' },
      { name: '급한 일 2', priority: 'urgent', deadline: '2026-10-01' },
      { name: '급한 일 3', priority: 'urgent', deadline: '2026-10-01' },
      { name: '논문지도비 송금', deadline: '2026-10-13' }, // 10/8 기준 5일 뒤
      { name: '딥러닝 원서 공부', deadline: '2026-08-31' },
      { name: '메일 정리', deadline: '' },
      { name: '딥러닝 스터디 PPT 준비', deadline: '' }, // 폰 입력으로 방금 만들어진 마감 없는 태스크
    ],
  });
  await w.store.record('intake', 'req1#0', { taskId: 7, name: '딥러닝 스터디 PPT 준비', deadline: '' }, T1.toISOString());
  await runDaily(w.make());
  const text = w.sent.join('\n');
  assert.match(text, /\[임박\]\n· 논문지도비 송금\(10\/13·5일 후\)/);
  assert.match(text, /\[밀린 일\]\n· 딥러닝 원서 공부\(8\/31, 38일째\)/);
  assert.match(text, /\[할 일\]\n· 메일 정리/);
  assert.match(text, /\[추가\]\n· 딥러닝 스터디 PPT 준비\(마감 없음\)/);
  assert.equal(text.match(/딥러닝 스터디 PPT 준비/g)?.length, 1, 'listed once, under "추가" only');
  assert.equal(text.match(/급한 일 1/g)?.length, 1, 'a Top 3 task is not repeated in the other sections');
});

test('a dry run shows the same sections without writing', async () => {
  const w = world({ tasks: [{ name: '메일 정리', deadline: '' }] });
  const out = await runDaily(w.make({ dryRun: true }));
  assert.match(out.messages.join('\n'), /\[먼저 할 일\]\n1\) 메일 정리/);
  assert.equal(w.sent.length, 0);
});

test('a task the user deleted in Veloo is not reported as added, while one that is still there is', async () => {
  const w = world({ tasks: [{ name: '남아 있는 일', deadline: '' }] }); // 벨루의 태스크 번호는 1
  await w.store.record('intake', 'req1#0', { taskId: 1, name: '남아 있는 일', deadline: '' }, T1.toISOString());
  await w.store.record('intake', 'req2#0', { taskId: 77, name: '지워진 일', deadline: '2026-10-06' }, T1.toISOString()); // 벨루에 없음
  await runDaily(w.make());
  const text = w.sent.join('\n');
  assert.match(text, /\[추가\]\n· 남아 있는 일/);
  assert.doesNotMatch(text, /지워진 일/);
});

test('a proposal that points at a task the user has since deleted is not shown', async () => {
  const w = world({ tasks: [{ name: '있는 일', deadline: '2026-11-18' }] });
  await w.store.record('proposal', 'a', { action: 'update_task', taskId: 1, name: '있는 일', currentDeadline: '2026-11-18', proposedDeadline: '2026-11-20' }, T1.toISOString());
  await w.store.record('proposal', 'b', { action: 'update_task', taskId: 99, name: '지워진 일', currentDeadline: '2026-11-18', proposedDeadline: '2026-11-20' }, T1.toISOString());
  await runDaily(w.make());
  const text = w.sent.join('\n');
  assert.match(text, /\[확인\]\n· '있는 일'/);
  assert.doesNotMatch(text, /지워진 일/);
});

test('entries filtered out because the task is gone are still passed, so they never come back the next day', async () => {
  const w = world();
  await w.store.record('intake', 'req1#0', { taskId: 77, name: '지워진 일', deadline: '' }, T1.toISOString());
  await runDaily(w.make());
  assert.equal(await w.store.getState('last_report_at'), new Date(T1.getTime() + 1).toISOString());
  w.sent.length = 0;
  w.setClock(T2);
  await runDaily(w.make({ now: T2 }));
  assert.doesNotMatch(w.sent.join('\n'), /지워진 일/);
});

test('when Veloo cannot be read the records cannot be checked, so they are shown and the failure is reported', async () => {
  const w = world({ veloo: 'down' });
  await w.store.record('intake', 'req1#0', { taskId: 77, name: '확인 못 하는 일', deadline: '' }, T1.toISOString());
  const out = await runDaily(w.make());
  const text = w.sent.join('\n');
  assert.match(text, /\[추가\]\n· 확인 못 하는 일/);
  assert.match(text, /· 벨루 읽기 실패/);
  assert.equal(out.sent, true);
});

test('the Top 3 come from the model when it answers, with its own reasons', async () => {
  const w = world({ tasks: [{ name: '송금', deadline: '2026-10-13' }, { name: '정리', deadline: '' }, { name: '발표', deadline: '2026-10-09' }] });
  const generateJson = async () => ({ picks: [{ id: 1, reason: '돈은 늦으면 곤란' }, { id: 3, reason: '내일 마감' }] });
  await runDaily(w.make({ generateJson }));
  const text = w.sent.join('\n');
  assert.match(text, /\[먼저 할 일\]\n1\) 송금 — 돈은 늦으면 곤란/);
  assert.match(text, /\n2\) 발표 — 내일 마감/);
});

test('if the model fails the Top 3 still appear, ranked by the rules', async () => {
  const w = world({ tasks: [{ name: '송금', deadline: '2026-10-13' }, { name: '발표', deadline: '2026-10-09' }] });
  const generateJson = async () => { throw new Error('quota'); };
  const out = await runDaily(w.make({ generateJson }));
  assert.equal(out.sent, true);
  assert.match(w.sent.join('\n'), /\[먼저 할 일\]\n1\) 발표 — 1일 남음/);
});

test('last week\'s review is read for the right week and shown; a failure becomes a note, not a crash', async () => {
  const ok = world({ weekly: 'ok' });
  await runDaily(ok.make());
  assert.match(ok.sent.join('\n'), /\[지난주\]\n· 완료 5 · 생성 9 · 밀림 3/);
  assert.deepEqual(ok.weeklyCalls, ['2026-09-28T00:00:00+09:00'], 'the Monday of the previous week, for a Thursday 10/8');

  const down = world({ weekly: 'down' });
  const out = await runDaily(down.make());
  assert.equal(out.sent, true);
  assert.match(down.sent.join('\n'), /· 지난주 통계를 읽지 못함\(review failed\)/);
  assert.doesNotMatch(down.sent.join('\n'), /\[지난주\]/);
});

test('when Veloo itself cannot be read, the weekly review is not attempted', async () => {
  const w = world({ weekly: 'ok', veloo: 'down' });
  await runDaily(w.make());
  assert.deepEqual(w.weeklyCalls, []);
});

test('mail deadlines come from the history ids, with no marker in the task memo', async () => {
  const w = world({ tasks: [{ name: '학회 초록 마감', deadline: '2026-11-20' }, { name: '폰으로 넣은 일', deadline: '2026-11-21' }] });
  await w.store.record('mail', 'm1#0', { taskId: 1, name: '학회 초록 마감', deadline: '2026-11-20' }, '2026-09-01T00:00:00.000Z');
  await w.store.record('intake', 'r1#0', { taskId: 2, name: '폰으로 넣은 일', deadline: '2026-11-21' }, '2026-09-01T00:00:00.000Z');
  await runDaily(w.make());
  const text = w.sent.join('\n');
  assert.match(text, /\[메일 마감\]\n· 학회 초록 마감\(11\/20·43일 후\)/);
  assert.doesNotMatch(text, /\[메일 마감\]\n· 폰으로 넣은 일/);
});

test('an old task with no deadline is reported as neglected, with how many days', async () => {
  const w = world({ tasks: [{ name: '오래된 일', deadline: '', created_at: '2026-09-05T00:00:00Z' }] });
  await runDaily(w.make());
  assert.match(w.sent.join('\n'), /\[방치\]\n· 오래된 일\(33일째\)/);
});

test('papers new this week are reported, and recorded so they are not new again next time', async () => {
  const papers: Paper[] = [{ key: 'p1', title: 'OpenHands', year: '2025', syncedAt: '2026-10-07T11:21:33Z' }];
  const w = world({ papers });
  await runDaily(w.make());
  assert.match(w.sent.join('\n'), /\[폴리오 · 이번 주 새 논문 1편\]\n· OpenHands/);
  assert.equal((await w.store.list('paper', '1970-01-01T00:00:00.000Z')).length, 1);
});

test('a dry run reports new papers without recording them', async () => {
  const w = world({ papers: [{ key: 'p1', title: 'OpenHands', year: null, syncedAt: '2026-10-07T11:21:33Z' }] });
  const out = await runDaily(w.make({ dryRun: true }));
  assert.match(out.messages.join('\n'), /\[폴리오 · 이번 주 새 논문 1편\]/);
  assert.equal((await w.store.list('paper', '1970-01-01T00:00:00.000Z')).length, 0);
});

test('if the Folio table cannot be read, the report still goes out with a note', async () => {
  const w = world({ papers: 'down' });
  const out = await runDaily(w.make());
  assert.equal(out.sent, true);
  assert.match(w.sent.join('\n'), /· 폴리오를 읽지 못함\(folio down\)/);
});

const undatedMail = (): MailTriageResult =>
  triage({
    candidates: [
      {
        mailId: 'm1',
        alsoMailIds: ['m2'],
        subject: '학회 투고 안내',
        tasks: [{ name: '학회 투고 안내', deadline: '', priority: 'normal', memo: '마감 확인 필요 · 메일: 학회 투고 안내\n- 확장논문 투고\n- 투고 완료 사실 회신' }],
      },
    ],
  });

test('a mail whose deadline is unclear still becomes a task without a deadline, and all mails of the thread are marked seen', async () => {
  const w = world({ mail: undatedMail });
  const outcome = await runDaily(w.make());
  assert.equal(outcome.sent, true);
  const created = w.tasks.find((t) => t.name === '학회 투고 안내');
  assert.ok(created, 'the task was written to the ledger');
  assert.equal(created.deadline, '');
  assert.match(created.memo, /마감 확인 필요/);
  assert.equal(await w.store.has('mail-seen', 'm1'), true);
  assert.equal(await w.store.has('mail-seen', 'm2'), true, 'the follow-up mail of the same thread is marked too');
  assert.doesNotMatch(w.sent.join('\n'), /마감일 불확실/);
});

test('in a dry run the undated mail task is only previewed, and nothing is written or marked', async () => {
  const w = world({ mail: undatedMail });
  const outcome = await runDaily(w.make({ dryRun: true }));
  assert.equal(outcome.sent, false);
  assert.equal(w.tasks.length, 0);
  assert.equal(await w.store.has('mail-seen', 'm1'), false);
  assert.match(outcome.messages.join('\n'), /학회 투고 안내 \(예정, 저장 안 함\)/);
});

test('a mail that took part in a failed write is not marked seen, even if its other task was written', async () => {
  const mail = () =>
    triage({
      candidates: [
        { mailId: 'm1', subject: '초록', tasks: [{ name: '초록 제출', deadline: '2026-11-20', priority: 'normal', memo: '' }] },
        { mailId: 'm2', alsoMailIds: ['m1'], subject: '학회 투고 안내', tasks: [{ name: '학회 투고 안내', deadline: '', priority: 'normal', memo: '마감 확인 필요' }] },
      ],
    });
  const w = world({ mail });
  const real = w.make().sync;
  const sync: DailyDeps['sync'] = async (candidates, source) =>
    source.id === 'm2'
      ? { created: [], skipped: [], proposed: [], warnings: [], failed: candidates.map((candidate) => ({ candidate, error: 'fetch failed' })) }
      : real(candidates, source);
  await runDaily(w.make({ sync }));
  assert.ok(w.tasks.find((t) => t.name === '초록 제출'), 'the dated task was written');
  assert.equal(await w.store.has('mail-seen', 'm1'), false, 'm1 also belongs to the failed undated candidate, so it is retried');
  assert.equal(await w.store.has('mail-seen', 'm2'), false);
});
