// 실제 Gemini를 호출하는 시험. 비용이 들고 결과가 매번 조금씩 달라서 기본 `npm test`에는 넣지 않는다.
// 실행: npm run test:live   (.env.local의 GEMINI_API_KEY, GEMINI_MODEL 필요)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGenerateJson } from '../src/adapters/gemini.ts';
import { interpretInput } from '../src/domain/interpret.ts';

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
// 모델을 바꿔 시험하려면: GEMINI_MODEL=<모델> npm run test:live
const generateJson = createGenerateJson({ apiKey: env.GEMINI_API_KEY.trim(), model: (process.env.GEMINI_MODEL ?? env.GEMINI_MODEL).trim() });

// 2026-10-07 수요일 12:00 KST
const now = new Date('2026-10-07T03:00:00Z');

const cases: { text: string; deadline: string; memo?: RegExp; priority?: string }[] = [
  { text: '금요일까지 교수님 메일 답장', deadline: '2026-10-09' },
  { text: '다음 주 화요일 3시 랩미팅', deadline: '2026-10-13', memo: /15:00/ },
  { text: '이번 주 안에 논문 X 읽기', deadline: '2026-10-11' },
  { text: '교수님 메일 답장', deadline: '' },
  { text: '11월 20일이 학회 초록 마감, 급함', deadline: '2026-11-20', priority: 'high' },
];

for (const c of cases) {
  test(`live: ${c.text}`, async () => {
    const result = await interpretInput({ text: c.text }, { generateJson, now });
    assert.ok('tasks' in result, JSON.stringify(result));
    assert.equal(result.tasks.length, 1, result.message);
    assert.equal(result.tasks[0].deadline, c.deadline, result.message);
    if (c.memo) assert.match(result.tasks[0].memo, c.memo);
    if (c.priority) assert.equal(result.tasks[0].priority, c.priority);
  });
}
