import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysBetween, lastWeekStart, mailDeadlines, pickTopTasks, rankTasks, staleTasks, type BriefTask } from '../../src/domain/brief.ts';

const TODAY = '2026-10-05'; // 월요일
const task = (over: Partial<BriefTask> = {}): BriefTask => ({
  id: 1, name: 't', memo: '', priority: 'normal', deadline: '', done: false, created_at: '2026-10-04T12:00:00Z', ...over,
});

test('daysBetween counts calendar days across month and year boundaries', () => {
  assert.equal(daysBetween('2026-10-05', '2026-10-09'), 4);
  assert.equal(daysBetween('2026-10-09', '2026-10-05'), -4);
  assert.equal(daysBetween('2026-10-30', '2026-11-03'), 4);
  assert.equal(daysBetween('2026-12-30', '2027-01-02'), 3);
});

test('a task due today outranks an urgent task due in a week, and an overdue task outranks both', () => {
  const ranked = rankTasks(
    [
      task({ id: 1, name: '일주일 뒤 급함', priority: 'urgent', deadline: '2026-10-12' }),
      task({ id: 2, name: '오늘 마감', deadline: '2026-10-05' }),
      task({ id: 3, name: '밀림', deadline: '2026-09-25' }),
    ],
    TODAY,
  );
  assert.deepEqual(ranked.map((r) => r.name), ['밀림', '오늘 마감', '일주일 뒤 급함']);
});

test('urgent and mid priority add weight, and the reason says so', () => {
  const [a, b, c] = rankTasks(
    [
      task({ id: 1, name: '보통', deadline: '2026-10-08' }),
      task({ id: 2, name: '급함', priority: 'urgent', deadline: '2026-10-08' }),
      task({ id: 3, name: '중요', priority: 'mid', deadline: '2026-10-08' }),
    ],
    TODAY,
  );
  assert.deepEqual([a.name, b.name, c.name], ['급함', '중요', '보통']);
  assert.equal(a.reason, '급함 · 3일 남음');
  assert.equal(b.reason, '중요 · 3일 남음');
});

test('reasons describe the deadline in plain words', () => {
  const r = Object.fromEntries(
    rankTasks(
      [
        task({ id: 1, name: 'today', deadline: '2026-10-05' }),
        task({ id: 2, name: 'late', deadline: '2026-10-01' }),
        task({ id: 3, name: 'soon', deadline: '2026-10-07' }),
        task({ id: 4, name: 'week', deadline: '2026-10-11' }),
        task({ id: 5, name: 'far', deadline: '2026-12-01' }),
      ],
      TODAY,
    ).map((x) => [x.name, x.reason]),
  );
  assert.equal(r.today, '오늘 마감');
  assert.equal(r.late, '4일 밀림');
  assert.equal(r.soon, '2일 남음');
  assert.equal(r.week, '6일 남음');
  assert.equal(r.far, '57일 남음', 'a far deadline still says how many days are left, never "no deadline"');
});

test('finished tasks are never ranked, and an old undated task is described as neglected', () => {
  const ranked = rankTasks(
    [task({ id: 1, name: '끝남', deadline: '2026-10-05', done: true }), task({ id: 2, name: '오래됨', created_at: '2026-09-05T00:00:00Z' })],
    TODAY,
  );
  assert.deepEqual(ranked.map((r) => r.name), ['오래됨']);
  assert.equal(ranked[0].reason, '30일째 방치');
});

test('ranking is stable: equal scores keep id order', () => {
  const ranked = rankTasks([task({ id: 2, name: 'b' }), task({ id: 1, name: 'a' })], TODAY);
  assert.deepEqual(ranked.map((r) => r.name), ['a', 'b']);
});

test('staleTasks lists undated open tasks older than the threshold, oldest first, with their age', () => {
  const stale = staleTasks(
    [
      task({ id: 1, name: '신선', created_at: '2026-10-01T00:00:00Z' }),
      task({ id: 2, name: '삼주', created_at: '2026-09-14T00:00:00Z' }),
      task({ id: 3, name: '한달', created_at: '2026-09-05T00:00:00Z' }),
      task({ id: 4, name: '마감 있음', deadline: '2026-10-20', created_at: '2026-08-01T00:00:00Z' }),
      task({ id: 5, name: '끝남', done: true, created_at: '2026-08-01T00:00:00Z' }),
    ],
    TODAY,
  );
  assert.deepEqual(stale, [{ name: '한달', days: 30 }, { name: '삼주', days: 21 }]);
});

test('mailDeadlines keeps only open mail-derived tasks that are not overdue, soonest first', () => {
  const list = mailDeadlines(
    [
      task({ id: 1, name: '학회', memo: '[비서:mail:m1#0]', deadline: '2026-11-20' }),
      task({ id: 2, name: '교수님', memo: '23:59\n[비서:mail:m2#0]', deadline: '2026-10-07' }),
      task({ id: 3, name: '지남', memo: '[비서:mail:m3#0]', deadline: '2026-10-01' }),
      task({ id: 4, name: '폰 입력', memo: '[비서:intake:x#0]', deadline: '2026-10-08' }),
      task({ id: 5, name: '끝남', memo: '[비서:mail:m5#0]', deadline: '2026-10-09', done: true }),
    ],
    TODAY,
  );
  assert.deepEqual(list, [
    { name: '교수님', deadline: '2026-10-07', daysLeft: 2 },
    { name: '학회', deadline: '2026-11-20', daysLeft: 46 },
  ]);
});

test('lastWeekStart is the Monday of the previous week at 00:00 KST', () => {
  assert.equal(lastWeekStart('2026-10-05'), '2026-09-28T00:00:00+09:00'); // 월요일
  assert.equal(lastWeekStart('2026-10-11'), '2026-09-28T00:00:00+09:00'); // 같은 주의 일요일
  assert.equal(lastWeekStart('2026-10-12'), '2026-10-05T00:00:00+09:00'); // 다음 주 월요일
  assert.equal(lastWeekStart('2026-01-02'), '2025-12-22T00:00:00+09:00'); // 해를 넘김
});

const ranked = () =>
  rankTasks(
    [
      task({ id: 1, name: 'A', deadline: '2026-10-05' }),
      task({ id: 2, name: 'B', priority: 'urgent', deadline: '2026-10-07' }),
      task({ id: 3, name: 'C', deadline: '2026-10-09' }),
      task({ id: 4, name: 'D', deadline: '2026-10-20' }),
    ],
    TODAY,
  );

test('without a model the top three come from the rules, with the rule reasons', async () => {
  const picks = await pickTopTasks(ranked(), TODAY);
  // 급함 + 2일 남음(6점)은 보통 + 오늘 마감(5점)보다 앞선다.
  assert.deepEqual(picks.map((p) => p.name), ['B', 'A', 'C']);
  assert.equal(picks[0].reason, '급함 · 2일 남음');
  assert.equal(picks[1].reason, '오늘 마감');
});

test('the model chooses among the candidates and writes the reasons', async () => {
  let prompt = '';
  const picks = await pickTopTasks(ranked(), TODAY, async (req) => {
    prompt = req.prompt;
    return { picks: [{ id: 2, reason: '송금은 늦으면 곤란함' }, { id: 1, reason: '오늘 마감' }, { id: 3, reason: '곧 마감' }] };
  });
  assert.deepEqual(picks.map((p) => p.name), ['B', 'A', 'C']);
  assert.equal(picks[0].reason, '송금은 늦으면 곤란함');
  assert.match(prompt, /id 2: B/);
  assert.match(prompt, /지어내지 마라/);
  assert.match(prompt, /명사형 어구/, 'asks for short phrases');
  assert.match(prompt, /문장형으로 쓰지 말고/, 'asks not to write full sentences');
});

test('an id the model made up is ignored and the gap is filled from the rules', async () => {
  const picks = await pickTopTasks(ranked(), TODAY, async () => ({ picks: [{ id: 999, reason: '없는 일' }, { id: 3, reason: '곧 마감' }] }));
  assert.equal(picks.length, 3);
  assert.equal(picks[0].name, 'C');
  assert.ok(!picks.some((p) => p.name === '없는 일'));
  assert.deepEqual(new Set(picks.map((p) => p.name)).size, 3, 'no duplicates');
});

test('a repeated pick is counted once', async () => {
  const picks = await pickTopTasks(ranked(), TODAY, async () => ({ picks: [{ id: 1, reason: 'x' }, { id: 1, reason: 'y' }] }));
  assert.deepEqual(picks.map((p) => p.name), ['A', 'B', 'C']);
});

test('a failing or malformed model falls back to the rule ranking', async () => {
  for (const bad of [new Error('quota'), null, 'text', { picks: 'no' }, {}]) {
    const picks = await pickTopTasks(ranked(), TODAY, async () => {
      if (bad instanceof Error) throw bad;
      return bad;
    });
    assert.deepEqual(picks.map((p) => p.name), ['B', 'A', 'C']);
  }
});

test('a long model reason is clipped and an empty one falls back to the rule reason', async () => {
  const picks = await pickTopTasks(ranked(), TODAY, async () => ({ picks: [{ id: 1, reason: '가'.repeat(80) }, { id: 2, reason: '  ' }] }));
  assert.equal(picks[0].reason.length, 30);
  assert.equal(picks[1].reason, '급함 · 2일 남음');
});

test('with zero or one open task the model is not called at all', async () => {
  let called = false;
  const gen = async () => { called = true; return { picks: [] }; };
  assert.deepEqual(await pickTopTasks([], TODAY, gen), []);
  const one = rankTasks([task({ id: 1, name: '하나', deadline: '2026-10-05' })], TODAY);
  assert.equal((await pickTopTasks(one, TODAY, gen)).length, 1);
  assert.equal(called, false);
});

test('mailDeadlines also recognises mail-made tasks by their id from the history, with no marker in the memo', () => {
  const list = mailDeadlines(
    [
      task({ id: 10, name: '기록에서 알아봄', memo: '', deadline: '2026-10-08' }),
      task({ id: 11, name: '메일 아님', memo: '', deadline: '2026-10-08' }),
    ],
    TODAY,
    new Set([10]),
  );
  assert.deepEqual(list.map((t) => t.name), ['기록에서 알아봄']);
});
