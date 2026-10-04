import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, calendarHint, interpretInput, validateInput, type GenerateJson } from './interpret.ts';

// 2026-10-07 수요일 12:00 KST
const NOW = new Date('2026-10-07T03:00:00Z');

function fakeModel(output: unknown) {
  const requests: Parameters<GenerateJson>[0][] = [];
  const generateJson: GenerateJson = async (request) => {
    requests.push(request);
    return output;
  };
  return { requests, generateJson };
}

const task = (over: Record<string, unknown> = {}) => ({
  name: '랩미팅',
  deadline: '2026-10-13',
  priority: 'normal',
  memo: '15:00',
  ...over,
});
const output = (over: Record<string, unknown> = {}) => ({
  tasks: [task()],
  assumptions: [],
  unreadable: [],
  ...over,
});

test('calendarHint starts today with its weekday and covers 14 days', () => {
  const lines = calendarHint(NOW).split('\n');
  assert.equal(lines.length, 14);
  assert.equal(lines[0], '2026-10-07 (수) 오늘');
  assert.equal(lines[1], '2026-10-08 (목) 내일');
  assert.equal(lines[2], '2026-10-09 (금)');
});

test('calendarHint uses the local date, not the UTC date', () => {
  // 2026-10-06 16:00 UTC는 한국에서는 이미 10월 7일 01:00이다.
  const lines = calendarHint(new Date('2026-10-06T16:00:00Z')).split('\n');
  assert.equal(lines[0], '2026-10-07 (수) 오늘');
});

test('text input: the prompt carries the user text and calendar; the result names task, date, and time', async () => {
  const { requests, generateJson } = fakeModel(output());
  const result = await interpretInput({ text: '다음 주 화요일 3시 랩미팅' }, { generateJson, now: NOW });

  assert.equal(requests.length, 1);
  assert.match(requests[0].prompt, /다음 주 화요일 3시 랩미팅/);
  assert.match(requests[0].prompt, /2026-10-07 \(수\) 오늘/);
  assert.equal(requests[0].image, undefined);

  assert.ok('message' in result);
  assert.match(result.message, /랩미팅\(10\/13, 15:00\)/);
  assert.equal(result.tasks[0].deadline, '2026-10-13');
});

test('image input: the image and its mime type reach the model', async () => {
  const { requests, generateJson } = fakeModel(output());
  await interpretInput({ image: 'QUJD', mimeType: 'image/png' }, { generateJson, now: NOW });
  assert.deepEqual(requests[0].image, { data: 'QUJD', mimeType: 'image/png' });
  assert.match(requests[0].prompt, /화면 캡처/);
});

test('image input defaults to image/jpeg', async () => {
  const { requests, generateJson } = fakeModel(output());
  await interpretInput({ image: 'QUJD' }, { generateJson, now: NOW });
  assert.equal(requests[0].image?.mimeType, 'image/jpeg');
});

test('input without text or image is rejected before the model is called', async () => {
  const { requests, generateJson } = fakeModel(output());
  for (const input of [{}, null, 'hello', { text: '   ' }, { text: 5 }]) {
    const result = await interpretInput(input, { generateJson, now: NOW });
    assert.ok('error' in result);
  }
  assert.equal(requests.length, 0);
});

test('no date: the task has no deadline and the reply says so with the assumption', async () => {
  const { generateJson } = fakeModel(
    output({
      tasks: [task({ name: '교수님 메일 답장', deadline: '', memo: '' })],
      assumptions: ['날짜 언급 없음 → 마감 없음'],
    }),
  );
  const result = await interpretInput({ text: '교수님 메일 답장' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.match(result.message, /교수님 메일 답장\(마감 없음\)/);
  assert.match(result.message, /추정: 날짜 언급 없음 → 마감 없음/);
});

test('unreadable parts are reported, never filled in', async () => {
  const { generateJson } = fakeModel(
    output({ tasks: [], unreadable: ['화면 아래쪽이 가려져 시간을 읽을 수 없음'] }),
  );
  const result = await interpretInput({ image: 'QUJD' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.match(result.message, /일정을 찾지 못했어요/);
  assert.match(result.message, /읽을 수 없음: 화면 아래쪽이 가려져/);
});

test('a past date is dropped and the reply explains it', async () => {
  const { generateJson } = fakeModel(output({ tasks: [task({ deadline: '2026-10-01' })] }));
  const result = await interpretInput({ text: '지난 일정' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.equal(result.tasks[0].deadline, '');
  assert.match(result.message, /지난 날짜라 마감 없음/);
});

test('an impossible date is dropped and the reply explains it', async () => {
  const { generateJson } = fakeModel(output({ tasks: [task({ deadline: '2026-02-31' })] }));
  const result = await interpretInput({ text: 'x' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.equal(result.tasks[0].deadline, '');
  assert.match(result.message, /날짜 형식을 알 수 없어/);
});

test('unknown priority falls back to normal and nameless tasks are skipped', async () => {
  const { generateJson } = fakeModel(
    output({ tasks: [task({ priority: 'urgent' }), task({ name: '  ' })] }),
  );
  const result = await interpretInput({ text: 'x' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].priority, 'normal');
});

test('a malformed model response throws instead of being guessed at', async () => {
  for (const bad of [null, 'text', { tasks: 'no' }, { tasks: [], assumptions: [], unreadable: 'x' }]) {
    const { generateJson } = fakeModel(bad);
    await assert.rejects(interpretInput({ text: 'x' }, { generateJson, now: NOW }), /invalid structure/);
  }
});

test('buildMessage joins several tasks', () => {
  const message = buildMessage(
    [
      { name: 'A', deadline: '2026-11-20', priority: 'high', memo: '' },
      { name: 'B', deadline: '', priority: 'normal', memo: '' },
    ],
    [],
    [],
  );
  assert.equal(message, '인식한 일정 2건: A(11/20) / B(마감 없음).');
});

test('validateInput accepts text or an image and rejects everything else without calling a model', () => {
  assert.equal(validateInput({ text: '금요일까지 보고서' }), null);
  assert.equal(validateInput({ image: 'QUJD' }), null);
  for (const bad of [{}, null, undefined, 'hello', { text: '   ' }, { text: 5 }, { image: '' }]) {
    assert.equal(validateInput(bad), 'text or image is required');
  }
});
