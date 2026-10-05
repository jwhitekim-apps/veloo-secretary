// 메일 선별 시험 실행(task 5.4): 실제 Gmail을 읽고 Gemini로 판단하지만, 벨루에 쓰지도 카톡을 보내지도 않는다.
// 처리 이력도 남기지 않으므로 몇 번이든 다시 돌려 볼 수 있다. 메일 내용이 Gemini로 전송된다는 점에 유의.
// 실행: npm run mail:dryrun [-- --days 30]
import { createGenerateJson } from '../src/adapters/gemini.js';
import { createGmail } from '../src/adapters/gmail.js';
import { interpretInput } from '../src/domain/interpret.js';
import { triageMail } from '../src/domain/mail.js';
import { createMemoryStore } from '../src/adapters/store.js';
import { loadEnvLocal } from './load-env.js';

const env = loadEnvLocal();
const daysIndex = process.argv.indexOf('--days');
const days = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) : 30;

const generateJson = createGenerateJson({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL });
const gmail = createGmail({
  clientId: env.GMAIL_CLIENT_ID,
  clientSecret: env.GMAIL_CLIENT_SECRET,
  refreshToken: env.GMAIL_REFRESH_TOKEN,
});
const keywords = env.MAIL_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean);
const now = new Date();

console.log(`키워드: ${keywords.join(', ')} | 기간: 최근 ${days}일 | 쓰기 없음\n`);
const result = await triageMail({
  gmail,
  generateJson,
  interpret: (text) => interpretInput({ text }, { generateJson, now }),
  store: createMemoryStore(),
  keywords,
  lookbackDays: days,
});

console.log(`키워드에 걸린 메일 ${result.stats.found}건 → 중요하다고 본 메일 ${result.stats.important}건`);
console.log(`\n[벨루에 추가될 후보] ${result.candidates.length}건`);
for (const c of result.candidates) {
  console.log(`  메일: ${c.subject}`);
  for (const t of c.tasks) console.log(`    - ${t.name} | 마감 ${t.deadline}${t.memo ? ` | ${t.memo}` : ''} | ${t.priority}`);
}
console.log(`\n[확인이 필요한 항목] ${result.uncertain.length}건`);
for (const u of result.uncertain) console.log(`  - ${u}`);
console.log(`\n[중요하지 않다고 본 메일] ${result.notImportantIds.length}건 (제목은 아래 일부)`);
console.log(`\n[처리 실패] ${result.failures.length}건`);
for (const f of result.failures) console.log(`  - ${f}`);
