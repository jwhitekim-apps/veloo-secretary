import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, pack, type ReportInput } from './report.ts';

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
