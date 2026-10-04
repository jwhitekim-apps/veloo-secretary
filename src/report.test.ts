import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, classifyOpenTasks, pack, type ReportInput } from './report.ts';

const NOW = new Date('2026-10-07T22:00:00Z'); // 한국 시간 10/8 07:00 목요일
const empty: ReportInput = { now: NOW, tasksToday: [], created: [], proposals: [], uncertain: [], failures: [] };

test('the header uses the local date and weekday', () => {
  const [message] = buildReport(empty, 200);
  assert.match(message.split('\n')[0], /^10\/8\(목\) 아침 보고$/);
});

test('a quiet day says so', () => {
  const [message] = buildReport(empty, 200);
  assert.match(message, /오늘 일정 없음\. 추가·확인할 사항도 없어요\./);
});

test('a day with only today\'s tasks lists them and nothing else', () => {
  const [message] = buildReport({ ...empty, tasksToday: [{ name: '랩미팅', memo: '15:00\n[비서:x]' }] }, 200);
  assert.match(message, /오늘: 랩미팅 15:00/);
  assert.doesNotMatch(message, /비서:x/, 'internal markers never leak into the report');
  assert.doesNotMatch(message, /추가:|확인:|실패/);
});

test('a day the assistant added tasks lists their names and deadlines', () => {
  const [message] = buildReport({ ...empty, created: [{ name: '학회 초록', deadline: '2026-11-20' }, { name: 'B', deadline: '' }] }, 200);
  assert.match(message, /추가: 학회 초록\(11\/20\)/);
  assert.match(message, /추가: B\(없음\)/);
});

test('failures come first, then confirmations, then additions, then today', () => {
  const [message] = buildReport(
    {
      ...empty,
      failures: ['메일 선별: 연결 실패'],
      proposals: [{ name: 'X', currentDeadline: '2026-11-18', proposedDeadline: '2026-11-20' }],
      uncertain: ['마감 불확실: Y'],
      created: [{ name: 'Z', deadline: '2026-11-01' }],
      tasksToday: [{ name: 'T', memo: '' }],
    },
    1000,
  );
  const order = ['⚠ 실패', '확인: \'X\'', '확인: 마감 불확실', '추가: Z', '오늘: T'].map((s) => message.indexOf(s));
  assert.ok(order.every((i) => i >= 0), message);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('every message fits the limit, and messages beyond the cap are cut with a count of omitted items', () => {
  const tasks = Array.from({ length: 80 }, (_, i) => ({ name: `일정 번호 ${i}`, memo: '' }));
  const messages = buildReport({ ...empty, failures: ['중요한 실패'], tasksToday: tasks }, 200, 3);
  assert.ok(messages.length <= 3);
  assert.ok(messages.every((m) => m.length <= 200), JSON.stringify(messages.map((m) => m.length)));
  assert.match(messages.join('\n'), /중요한 실패/, 'the important line survives');
  assert.match(messages[messages.length - 1], /…외 \d+건 생략$/);
});

test('the omitted count equals the number of lines that were actually dropped', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `줄 ${String(i).padStart(2, '0')}`);
  const messages = pack(lines, 60, 2);
  const shown = messages.join('\n').split('\n').filter((l) => l.startsWith('줄 ')).length;
  const omitted = Number(messages.join('\n').match(/외 (\d+)건 생략/)![1]);
  assert.equal(shown + omitted, 30);
});

test('a single line longer than the limit is clipped, not dropped', () => {
  const messages = pack(['가'.repeat(500)], 200, 3);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].length, 200);
  assert.ok(messages[0].endsWith('…'));
});

test('short reports stay in a single message', () => {
  assert.equal(buildReport({ ...empty, tasksToday: [{ name: 'A', memo: '' }] }, 200).length, 1);
});

test('upcoming, overdue and undated tasks get their own labelled lines after today\'s tasks', () => {
  const [message] = buildReport(
    {
      ...empty,
      tasksToday: [{ name: 'T', memo: '' }],
      upcoming: [{ name: '송금', deadline: '2026-10-13' }],
      overdue: [{ name: '원서', deadline: '2026-08-31' }],
      undated: [{ name: '정리', note: '' }, { name: '메모', note: '이번 주' }],
    },
    1000,
  );
  const order = ['오늘: T', '임박: 송금(10/13)', '밀린 일: 원서(8/31)', '할 일: 정리', '할 일: 메모(이번 주)'].map((s) => message.indexOf(s));
  assert.ok(order.every((i) => i >= 0), message);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a section shows at most five items and counts the rest', () => {
  const undated = Array.from({ length: 8 }, (_, i) => ({ name: `일 ${i + 1}`, note: '' }));
  const [message] = buildReport({ ...empty, undated }, 1000);
  assert.equal((message.match(/^할 일: 일 \d$/gm) ?? []).length, 5);
  assert.match(message, /^할 일: 외 3건$/m);
});

test('a day with only open tasks does not claim it is quiet', () => {
  const [message] = buildReport({ ...empty, undated: [{ name: '정리', note: '' }] }, 200);
  assert.doesNotMatch(message, /오늘 일정 없음\. 추가·확인할 사항도 없어요/);
  assert.match(message, /오늘 마감인 일정은 없어요/);
});

const T = (name: string, deadline: string, done = false) => ({ name, memo: '', deadline, done });

test('classify: the upcoming window is tomorrow through seven days ahead, inclusive', () => {
  const r = classifyOpenTasks([T('a', '2026-10-08'), T('b', '2026-10-14'), T('c', '2026-10-15')], '2026-10-07');
  assert.deepEqual(r.upcoming.map((t) => t.name), ['a', 'b'], '10/15 is eight days out and is excluded');
});

test('classify: today, overdue and undated are separated, finished tasks are dropped', () => {
  const r = classifyOpenTasks([T('오늘', '2026-10-07'), T('어제', '2026-10-06'), T('없음', ''), T('끝', '2026-10-07', true)], '2026-10-07');
  assert.deepEqual(r.today.map((t) => t.name), ['오늘']);
  assert.deepEqual(r.overdue.map((t) => t.name), ['어제']);
  assert.deepEqual(r.undated.map((t) => t.name), ['없음']);
});

test('classify: a free-text deadline is treated as undated and keeps its wording', () => {
  const r = classifyOpenTasks([T('송금', '이번 주 안에')], '2026-10-07');
  assert.deepEqual(r.undated, [{ name: '송금', note: '이번 주 안에' }]);
  assert.equal(r.upcoming.length + r.overdue.length + r.today.length, 0);
});

test('classify: lists are sorted by date and names to exclude are skipped', () => {
  const r = classifyOpenTasks([T('늦음', '2026-10-12'), T('빠름', '2026-10-09'), T('제외', '2026-10-10')], '2026-10-07', new Set(['제외']));
  assert.deepEqual(r.upcoming.map((t) => t.name), ['빠름', '늦음']);
});

test('classify: the window handles month boundaries', () => {
  const r = classifyOpenTasks([T('a', '2026-11-03')], '2026-10-30');
  assert.deepEqual(r.upcoming.map((t) => t.name), ['a']);
});
