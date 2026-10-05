// Gmail 연결 점검(task 1.3): 최근 메일 제목 5개를 읽고, 쓰기·삭제 호출이 권한 오류로 거부되는지 확인한다.
// 실행: npm run gmail:check          (제목은 앞 8글자만 보여 준다)
//       npm run gmail:check -- --full (제목 전체를 보여 준다)
import { createGmail } from '../src/adapters/gmail.js';
import { loadEnvLocal } from './load-env.js';

const env = loadEnvLocal();
const full = process.argv.includes('--full');
const show = (s: string) => (full || s.length <= 8 ? s : `${s.slice(0, 8)}…`);

const gmail = createGmail({
  clientId: env.GMAIL_CLIENT_ID,
  clientSecret: env.GMAIL_CLIENT_SECRET,
  refreshToken: env.GMAIL_REFRESH_TOKEN,
});

const metas = await gmail.search('newer_than:30d', 5);
console.log(`읽기: 최근 30일 메일 ${metas.length}건`);
for (const m of metas) {
  const domain = m.from.match(/@([\w.-]+)/)?.[1] ?? '?';
  console.log(`  - [${domain}] ${show(m.subject)}`);
}

// 쓰기 거부 확인: 같은 토큰으로 발송과 휴지통 이동을 시도한다. 둘 다 403이어야 한다.
const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: env.GMAIL_CLIENT_ID,
    client_secret: env.GMAIL_CLIENT_SECRET,
    refresh_token: env.GMAIL_REFRESH_TOKEN,
  }),
});
const { access_token: token } = (await tokenRes.json()) as { access_token: string };
const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
const attempts: [string, string, string?][] = [
  ['발송 시도', `${base}/messages/send`, JSON.stringify({ raw: 'AAAA' })],
  ['휴지통 이동 시도', `${base}/messages/${metas[0]?.id ?? 'x'}/trash`],
];
let allRejected = true;
for (const [label, url, body] of attempts) {
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
  const reason = ((await res.json().catch(() => ({}))) as { error?: { status?: string } }).error?.status ?? '';
  console.log(`쓰기 거부 확인 - ${label}: HTTP ${res.status} ${reason}`);
  if (res.status !== 403) allRejected = false;
}
console.log(allRejected ? '결과: 읽기만 가능, 쓰기는 모두 거부됨 ✓' : '결과: 쓰기가 거부되지 않았습니다. 권한을 확인하세요 ✗');
process.exit(allRejected ? 0 : 1);
