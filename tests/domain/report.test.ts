import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, classifyOpenTasks, pack, packSections, stripMarker, type ReportInput } from '../../src/domain/report.ts';

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
  assert.match(message, /\[오늘\]\n· 랩미팅 15:00/);
  assert.doesNotMatch(message, /비서:x/, 'internal markers never leak into the report');
  assert.doesNotMatch(message, /\[추가\]|\[확인\]|실패/);
});

test('a day the assistant added tasks lists their names and deadlines', () => {
  const [message] = buildReport({ ...empty, created: [{ name: '학회 초록', deadline: '2026-11-20' }, { name: 'B', deadline: '' }] }, 200);
  assert.match(message, /\[추가\]\n· 학회 초록\(11\/20\)/);
  assert.match(message, /· B\(마감 없음\)/);
});

test('failures come first, then confirmations, then today, and additions come later', () => {
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
  const order = ['[⚠ 실패]', '[확인]', '· 마감 불확실: Y', '[오늘]', '[추가]'].map((s) => message.indexOf(s));
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

test('overdue, upcoming and undated tasks get their own labelled lines after today\'s tasks', () => {
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
  const order = ['[오늘]', '[밀린 일]\n· 원서(8/31)', '[임박]\n· 송금(10/13)', '[할 일]\n· 정리', '· 메모(이번 주)'].map((s) => message.indexOf(s));
  assert.ok(order.every((i) => i >= 0), message);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('a section shows at most five items and counts the rest', () => {
  const undated = Array.from({ length: 8 }, (_, i) => ({ name: `일 ${i + 1}`, note: '' }));
  const [message] = buildReport({ ...empty, undated }, 1000);
  assert.equal((message.match(/^· 일 \d$/gm) ?? []).length, 5);
  assert.match(message, /^· 외 3건$/m);
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

test('a task whose only memo is the internal marker shows no memo at all', () => {
  const [message] = buildReport({ ...empty, tasksToday: [{ name: '비서 어플 테스트', memo: '[비서:intake:c3b44f7c-e1e8-434d-b1cf-125c7770ae3b#0]' }] }, 200);
  assert.match(message, /^· 비서 어플 테스트$/m);
  assert.doesNotMatch(message, /비서:intake|c3b44f7c/);
});

test('a time memo is kept and the marker after it is dropped', () => {
  const [message] = buildReport({ ...empty, tasksToday: [{ name: '랩미팅', memo: '15:00\n[비서:mail:m1#0]' }] }, 200);
  assert.match(message, /^· 랩미팅 15:00$/m);
  assert.doesNotMatch(message, /비서:mail/);
});

test('a marker placed before the user\'s own note does not hide the note', () => {
  const [message] = buildReport({ ...empty, tasksToday: [{ name: '일', memo: '[비서:intake:x#0]\n직접 쓴 메모' }] }, 200);
  assert.match(message, /^· 일 직접 쓴 메모$/m);
});

test('stripMarker removes every marker and trims, and leaves ordinary text alone', () => {
  assert.equal(stripMarker('[비서:intake:a#0]'), '');
  assert.equal(stripMarker('15:00\n[비서:mail:b#1]'), '15:00');
  assert.equal(stripMarker('앞 [비서:x:1] 뒤 [비서:y:2]'), '앞  뒤');
  assert.equal(stripMarker('그냥 메모 [참고]'), '그냥 메모 [참고]');
});

test('the Top 3 lines come right after confirmations, with their one-line reasons', () => {
  const [message] = buildReport(
    { ...empty, top: [{ name: '논문지도비 송금', reason: '급함 · 4일 남음' }, { name: '원서 공부', reason: '35일 밀림' }], tasksToday: [{ name: 'T', memo: '' }], failures: ['x'] },
    1000,
  );
  const order = ['[⚠ 실패]\n· x', '[먼저 할 일]\n1) 논문지도비 송금 — 급함 · 4일 남음', '2) 원서 공부 — 35일 밀림', '[오늘]'].map((s) => message.indexOf(s));
  assert.ok(order.every((i) => i >= 0), message);
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('overdue and upcoming lines show how many days, when known', () => {
  const [message] = buildReport(
    { ...empty, overdue: [{ name: '원서', deadline: '2026-08-31', days: 35 }], upcoming: [{ name: '송금', deadline: '2026-10-09', daysLeft: 1 }] },
    1000,
  );
  assert.match(message, /· 원서\(8\/31, 35일째\)/);
  assert.match(message, /· 송금\(10\/9·1일 후\)/);
});

test('mail deadlines, neglected tasks, papers and last week appear in their own lines', () => {
  const [message] = buildReport(
    {
      ...empty,
      mailDeadlines: [{ name: '학회 초록', deadline: '2026-11-20', daysLeft: 46 }],
      stale: [{ name: '메일 정리', days: 23 }],
      papers: { count: 3, titles: ['Attention Is All You Need', 'ReAct'] },
      weekly: { completed: 5, created: 9, overdue: 3 },
    },
    1000,
  );
  assert.match(message, /\[메일 마감\]\n· 학회 초록\(11\/20·46일 후\)/);
  assert.match(message, /\[방치\]\n· 메일 정리\(23일째\)/);
  assert.match(message, /\[폴리오 · 이번 주 새 논문 3편\]\n· Attention Is All You Need\n· ReAct/);
  assert.match(message, /\[지난주\]\n· 완료 5 · 생성 9 · 밀림 3/);
});

test('no new papers and no weekly data add no lines', () => {
  const [message] = buildReport({ ...empty, papers: { count: 0, titles: [] }, weekly: null, tasksToday: [{ name: 'T', memo: '' }] }, 1000);
  assert.doesNotMatch(message, /폴리오|지난주/);
});

test('identical added tasks are collapsed into one line with a count', () => {
  const [message] = buildReport(
    { ...empty, created: [{ name: '당근 택배 수거', deadline: '2026-10-06' }, { name: '당근 택배 수거', deadline: '2026-10-06' }, { name: '다른 일', deadline: '' }] },
    1000,
  );
  assert.match(message, /· 당근 택배 수거\(10\/6\) ×2/);
  assert.equal((message.match(/· 당근 택배 수거/g) ?? []).length, 1);
  assert.match(message, /· 다른 일\(마감 없음\)/);
});

test('when space runs out, the lines at the bottom are cut first and the important ones stay', () => {
  // 오늘 마감은 개수 제한이 없는 구역이라 80개면 카톡 3통(600자)을 넘친다.
  const tasksToday = Array.from({ length: 80 }, (_, i) => ({ name: `오늘 일 ${i}`, memo: '' }));
  const messages = buildReport(
    {
      ...empty,
      failures: ['중요한 실패'],
      top: [{ name: '핵심', reason: '급함' }],
      tasksToday,
      papers: { count: 1, titles: ['논문'] },
      weekly: { completed: 1, created: 1, overdue: 0 },
    },
    200,
    3,
  );
  const text = messages.join('\n');
  assert.ok(messages.length <= 3 && messages.every((m) => m.length <= 200));
  assert.match(text, /\[⚠ 실패\]\n· 중요한 실패/);
  assert.match(text, /1\) 핵심/);
  assert.doesNotMatch(text, /\[폴리오|\[지난주\]/, 'the lower-priority sections were cut');
  assert.match(text, /…외 \d+건 생략$/);
});

test('classify: days overdue and days left are computed from today', () => {
  const r = classifyOpenTasks([T('늦음', '2026-10-02'), T('곧', '2026-10-09')], '2026-10-07');
  assert.deepEqual(r.overdue, [{ name: '늦음', deadline: '2026-10-02', days: 5 }]);
  assert.deepEqual(r.upcoming, [{ name: '곧', deadline: '2026-10-09', daysLeft: 2 }]);
});

test('classify: dedupeNames hides already-shown tasks everywhere except today', () => {
  const r = classifyOpenTasks(
    [T('오늘 것', '2026-10-07'), T('임박 것', '2026-10-09'), T('밀린 것', '2026-10-01'), T('할 것', '')],
    '2026-10-07',
    new Set(),
    7,
    new Set(['오늘 것', '임박 것', '밀린 것', '할 것']),
  );
  assert.deepEqual(r.today.map((t) => t.name), ['오늘 것']);
  assert.equal(r.upcoming.length + r.overdue.length + r.undated.length, 0);
});

test('a long paper title is shortened so one title cannot fill the whole message', () => {
  const long = 'OpenHands: An Open Platform for AI Software Developers as Generalist Agents';
  const [message] = buildReport({ ...empty, papers: { count: 1, titles: [long] } }, 1000);
  const line = message.split('\n').find((l) => l.startsWith('· OpenHands'))!;
  assert.match(line, /^· OpenHands: An Open Platform for AI Soft…$/);
  assert.equal(line.slice(2).length, 40, 'the title is cut to 40 characters including the ellipsis');
  assert.ok(!line.includes('Generalist Agents'));
  const short = buildReport({ ...empty, papers: { count: 1, titles: ['ReAct'] } }, 1000)[0];
  assert.match(short, /^· ReAct$/m);
});

// --- 구역 단위 말풍선 ---

const messagesOf = (input: Partial<ReportInput>, limit = 200, max = 3) => buildReport({ ...empty, ...input }, limit, max);

test('a section is never split across two message bubbles when it fits in one', () => {
  const messages = messagesOf({
    top: [{ name: '핵심 일 하나', reason: '급함' }, { name: '두 번째 일', reason: '곧' }, { name: '세 번째 일', reason: '밀림' }],
    tasksToday: [{ name: '오늘 일 A', memo: '' }, { name: '오늘 일 B', memo: '' }],
    overdue: Array.from({ length: 5 }, (_, i) => ({ name: `밀린 긴 이름의 일 번호 ${i + 1}`, deadline: '2026-09-01', days: 36 })),
  });
  assert.ok(messages.length >= 2, 'the overdue section does not fit the first bubble');
  const holder = messages.filter((m) => m.includes('[밀린 일]'));
  assert.equal(holder.length, 1, 'the whole section sits in one bubble');
  for (let i = 1; i <= 5; i += 1) assert.match(holder[0], new RegExp(`밀린 긴 이름의 일 번호 ${i}\\(`));
  assert.ok(messages.every((m) => m.length <= 200));
});

test('a section longer than one bubble is split by items, and the continuation repeats the section name', () => {
  const tasksToday = Array.from({ length: 30 }, (_, i) => ({ name: `오늘 일 ${String(i).padStart(2, '0')}`, memo: '' }));
  const messages = messagesOf({ tasksToday }, 200, 5);
  const text = messages.join('\n');
  assert.match(text, /\[오늘\]/);
  assert.match(text, /\[오늘 \(이어서\)\]/);
  assert.ok(messages.every((m) => m.length <= 200), JSON.stringify(messages.map((m) => m.length)));
  const shown = (text.match(/^· 오늘 일 \d\d$/gm) ?? []).length;
  assert.equal(shown, 30, 'nothing is lost when there is room for every piece');
});

test('several bubbles are numbered, a single one is not', () => {
  const many = messagesOf({ tasksToday: Array.from({ length: 30 }, (_, i) => ({ name: `일 ${i}`, memo: '' })) }, 200, 3);
  assert.ok(many.length > 1);
  assert.match(many[0].split('\n')[0], new RegExp(` \\(1/${many.length}\\)$`));
  many.slice(1).forEach((m, i) => assert.match(m.split('\n')[0], new RegExp(`^\\(${i + 2}/${many.length}\\)$`)));
  const one = messagesOf({ tasksToday: [{ name: '하나', memo: '' }] });
  assert.equal(one.length, 1);
  assert.doesNotMatch(one[0], /\(\d\/\d\)/);
});

test('sections that do not fit are left out whole, in priority order, and the omitted count matches the dropped items', () => {
  const tasksToday = Array.from({ length: 60 }, (_, i) => ({ name: `오늘 일 ${String(i).padStart(2, '0')}`, memo: '' }));
  const messages = messagesOf({ failures: ['중요한 실패'], tasksToday, weekly: { completed: 1, created: 2, overdue: 3 } }, 200, 3);
  const text = messages.join('\n');
  assert.match(text, /\[⚠ 실패\]\n· 중요한 실패/);
  assert.doesNotMatch(text, /\[지난주\]/, 'a lower-priority section does not jump ahead of the cut-off one');
  const shown = (text.match(/^· 오늘 일 \d\d$/gm) ?? []).length;
  const omitted = Number(text.match(/…외 (\d+)건 생략$/)![1]);
  assert.equal(shown + omitted, 60 + 1, 'every dropped item (the 60 tasks and the weekly line) is counted');
  assert.ok(messages.length <= 3 && messages.every((m) => m.length <= 200));
});

test('every bubble stays within the limit for a range of limits and report sizes', () => {
  for (const limit of [120, 200, 400]) {
    for (const n of [0, 3, 12, 40]) {
      const messages = messagesOf(
        {
          failures: n > 5 ? ['일부 처리에 실패했습니다'] : [],
          top: [{ name: '먼저 할 일 하나', reason: '급함 · 이틀 남음' }],
          tasksToday: Array.from({ length: n }, (_, i) => ({ name: `일정 ${i}`, memo: '15:00' })),
          upcoming: Array.from({ length: n }, (_, i) => ({ name: `다가오는 일 ${i}`, deadline: '2026-10-12', daysLeft: 4 })),
        },
        limit,
        3,
      );
      assert.ok(messages.length >= 1 && messages.length <= 3);
      assert.ok(messages.every((m) => m.length <= limit), `limit ${limit}, n ${n}: ${JSON.stringify(messages.map((m) => m.length))}`);
    }
  }
});

test('packSections keeps the header alone when there is nothing else, and never returns an empty bubble', () => {
  assert.deepEqual(packSections('머리말', [], 200, 3), ['머리말']);
  const messages = packSections('머리말', [{ title: '구역', items: ['· 항목'] }], 200, 3);
  assert.deepEqual(messages, ['머리말\n\n[구역]\n· 항목']);
});
