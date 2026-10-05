import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMessage, calendarHint, interpretInput, readBackText, validateInput, type GenerateJson } from './interpret.ts';

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

test('the image prompt tells the model it may be a handwritten photo and to copy text exactly as seen', async () => {
  const { requests, generateJson } = fakeModel(output());
  await interpretInput({ image: 'QUJD' }, { generateJson, now: NOW });
  const prompt = requests[0].prompt;
  assert.match(prompt, /카메라로 찍은 사진\(손글씨 메모/);
  assert.match(prompt, /보이는 그대로/);
  assert.match(prompt, /바꾸지 마라/, 'no silent replacement of words');
  assert.match(prompt, /하나도 빠뜨리지 마라/, 'every list item becomes a task');
});

test('for an image, the reply echoes what the model read so misreadings are visible', async () => {
  const { generateJson } = fakeModel(output({ transcript: '이번 주 내로 뭘 하고 싶은지 명확하게 하고\n다른 논문들 더 찾아보기' }));
  const result = await interpretInput({ image: 'QUJD' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.match(result.message, / 읽은 내용: "이번 주 내로 뭘 하고 싶은지 명확하게 하고 다른 논문들 더 찾아보기"\.$/);
  assert.equal(result.transcript, '이번 주 내로 뭘 하고 싶은지 명확하게 하고\n다른 논문들 더 찾아보기');
});

test('for text input the reply never echoes a transcript', async () => {
  const { generateJson } = fakeModel(output({ transcript: '모델이 채워 버린 값' }));
  const result = await interpretInput({ text: '다음 주 화요일 3시 랩미팅' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.doesNotMatch(result.message, /읽은 내용/);
});

test('a model response without a transcript is still accepted', async () => {
  const { generateJson } = fakeModel({ tasks: [task()], assumptions: [], unreadable: [] });
  const result = await interpretInput({ image: 'QUJD' }, { generateJson, now: NOW });
  assert.ok('message' in result);
  assert.equal(result.transcript, '');
  assert.doesNotMatch(result.message, /읽은 내용/);
});

test('several items from one photo all come through, in order', async () => {
  const { generateJson } = fakeModel(
    output({
      tasks: [
        task({ name: '이번 주 내로 뭘 하고 싶은지 명확하게 하기', deadline: '2026-10-11', memo: '' }),
        task({ name: '다른 논문들 더 찾아보기', deadline: '', memo: '' }),
      ],
    }),
  );
  const result = await interpretInput({ image: 'QUJD' }, { generateJson, now: NOW });
  assert.ok('tasks' in result);
  assert.deepEqual(result.tasks.map((t) => t.name), ['이번 주 내로 뭘 하고 싶은지 명확하게 하기', '다른 논문들 더 찾아보기']);
});

test('readBackText collapses whitespace, clips long text, and returns nothing for empty text', () => {
  assert.equal(readBackText(''), '');
  assert.equal(readBackText('   \n '), '');
  assert.equal(readBackText('가\n나   다'), ' 읽은 내용: "가 나 다".');
  const long = readBackText('가'.repeat(300));
  assert.ok(long.endsWith('…".'));
  assert.ok(long.length < 130);
});

test('the requested quality is passed to the model call, and left out when not requested', async () => {
  const a = fakeModel(output());
  await interpretInput({ image: 'QUJD' }, { generateJson: a.generateJson, now: NOW, quality: 'high' });
  assert.equal(a.requests[0].quality, 'high');
  const b = fakeModel(output());
  await interpretInput({ image: 'QUJD' }, { generateJson: b.generateJson, now: NOW });
  assert.equal(b.requests[0].quality, undefined);
});

// 호출 순서대로 다른 응답을 돌려주는 가짜 모델. 응답이 Error이면 던진다.
function sequenceModel(outputs: unknown[]) {
  const requests: Parameters<GenerateJson>[0][] = [];
  const generateJson: GenerateJson = async (request) => {
    requests.push(request);
    const next = outputs[Math.min(requests.length - 1, outputs.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
  return { requests, generateJson };
}

const light = (over: Record<string, unknown> = {}) => output({ handwritten: true, transcript: '원하고 싶은지', tasks: [task({ name: '원하고 싶은지 명확하게 하기' })], ...over });
const big = () => output({ handwritten: true, transcript: '뭘하고 싶은지', tasks: [task({ name: '뭘하고 싶은지 명확하게 하기' })] });

test('a handwritten image is re-read with the larger model and its result is used', async () => {
  const m = sequenceModel([light(), big()]);
  const result = await interpretInput({ image: 'QUJD' }, { generateJson: m.generateJson, now: NOW, escalate: true });
  assert.equal(m.requests.length, 2);
  assert.equal(m.requests[0].quality, undefined, 'the first read uses the default model');
  assert.equal(m.requests[1].quality, 'high', 'the second read asks for the large model');
  assert.ok('tasks' in result);
  assert.equal(result.tasks[0].name, '뭘하고 싶은지 명확하게 하기');
  assert.equal(result.transcript, '뭘하고 싶은지');
  assert.equal(result.escalated, true);
});

test('a printed image (not handwritten) is read once', async () => {
  const m = sequenceModel([output({ handwritten: false })]);
  const result = await interpretInput({ image: 'QUJD' }, { generateJson: m.generateJson, now: NOW, escalate: true });
  assert.equal(m.requests.length, 1);
  assert.ok('tasks' in result);
  assert.equal(result.escalated, false);
});

test('without escalation enabled (no large model configured) a handwritten image is read once', async () => {
  const m = sequenceModel([light()]);
  await interpretInput({ image: 'QUJD' }, { generateJson: m.generateJson, now: NOW });
  await interpretInput({ image: 'QUJD' }, { generateJson: m.generateJson, now: NOW, escalate: false });
  assert.equal(m.requests.length, 2, 'one call per request, no re-read');
});

test('when high quality was already requested there is no second read', async () => {
  const m = sequenceModel([big()]);
  const result = await interpretInput({ image: 'QUJD' }, { generateJson: m.generateJson, now: NOW, escalate: true, quality: 'high' });
  assert.equal(m.requests.length, 1);
  assert.equal(m.requests[0].quality, 'high');
  assert.ok('tasks' in result);
  assert.equal(result.escalated, false);
});

test('text input is never re-read, even if the model claims it is handwritten', async () => {
  const m = sequenceModel([light()]);
  await interpretInput({ text: '다음 주 화요일 3시 랩미팅' }, { generateJson: m.generateJson, now: NOW, escalate: true });
  assert.equal(m.requests.length, 1);
});

test('if the large model fails, the first reading is kept and the reply says it could not be re-read', async () => {
  const m = sequenceModel([light(), new Error('model retired')]);
  const result = await interpretInput({ image: 'QUJD' }, { generateJson: m.generateJson, now: NOW, escalate: true });
  assert.ok('tasks' in result);
  assert.equal(result.tasks[0].name, '원하고 싶은지 명확하게 하기');
  assert.equal(result.escalated, false);
  assert.match(result.message, /큰 모델로 다시 읽지 못해/);
});

test('the prompt asks whether the text is handwritten', async () => {
  const m = sequenceModel([output()]);
  await interpretInput({ image: 'QUJD' }, { generateJson: m.generateJson, now: NOW });
  assert.match(m.requests[0].prompt, /handwritten: .*손으로 쓴 글씨이면 true/);
});
