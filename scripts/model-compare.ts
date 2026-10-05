// 같은 사진을 여러 모델과 여러 해상도로 읽혀서 비교한다(손글씨가 잘 읽히는 설정을 찾는 용도).
// 사진은 이 컴퓨터에서 줄여서 Gemini로만 보낸다. 벨루에 쓰거나 카톡을 보내지 않는다.
// 실행: npm run model:compare -- <사진 경로> [--models a,b,c] [--widths 1000,2000]
// (macOS의 sips로 크기를 줄인다)
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGenerateJson } from '../src/adapters/gemini.js';
import { interpretInput } from '../src/domain/interpret.js';
import { loadEnvLocal } from './load-env.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const path = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!path) {
  console.error('사용법: npm run model:compare -- <사진 경로> [--models a,b,c] [--widths 1000,2000]');
  process.exit(1);
}
const models = flag('--models', 'gemini-3.6-flash,gemini-3.8-flash,gemini-3.1-pro-preview').split(',');
const widths = flag('--widths', '1000,2000').split(',').map(Number);

const env = loadEnvLocal();
const apiKey = env.GEMINI_API_KEY.trim();

function prepare(width: number): string {
  const out = join(tmpdir(), `model-compare-${width}-${Date.now()}.jpg`);
  execFileSync('sips', ['--resampleWidth', String(width), '-s', 'format', 'jpeg', path!, '--out', out], { stdio: 'ignore' });
  const base64 = readFileSync(out).toString('base64');
  rmSync(out);
  return base64;
}

const images = new Map(widths.map((w) => [w, prepare(w)]));
console.log(`사진: ${path}`);
for (const [w, b64] of images) console.log(`  가로 ${w}px → Base64 ${Math.round(b64.length / 1024)}KB`);
console.log(`모델 ${models.length}개 × 해상도 ${widths.length}개를 읽힙니다...\n`);

const now = new Date();
const jobs = models.flatMap((model) => widths.map((width) => ({ model, width })));
const results = await Promise.all(
  jobs.map(async ({ model, width }) => {
    const started = Date.now();
    try {
      const generateJson = createGenerateJson({ apiKey, model });
      const r = await interpretInput({ image: images.get(width) }, { generateJson, now });
      return { model, width, seconds: (Date.now() - started) / 1000, r };
    } catch (e) {
      return { model, width, seconds: (Date.now() - started) / 1000, error: e instanceof Error ? e.message : String(e) };
    }
  }),
);

for (const x of results) {
  console.log(`━━ ${x.model} / 가로 ${x.width}px / ${x.seconds.toFixed(1)}초`);
  if ('error' in x && x.error) { console.log(`  오류: ${x.error}`); continue; }
  const r = (x as { r: Awaited<ReturnType<typeof interpretInput>> }).r;
  if ('error' in r) { console.log(`  오류: ${r.error}`); continue; }
  console.log(`  읽은 내용: ${JSON.stringify(r.transcript)}`);
  for (const t of r.tasks) console.log(`  - ${t.name} | ${t.deadline || '마감 없음'}${t.memo ? ` | ${t.memo}` : ''}`);
  if (r.unreadable.length) console.log(`  읽을 수 없음: ${r.unreadable.join('; ')}`);
}
