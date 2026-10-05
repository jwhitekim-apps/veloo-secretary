// 저장소 점검: 실제 Supabase에 기록·중복 판별·조회·상태 저장을 시험하고, 시험 데이터를 지운다.
// 실행: npm run store:check
import { createSupabaseStore } from '../src/adapters/store.js';
import { loadEnvLocal } from './load-env.js';

const env = loadEnvLocal();
const url = env.SUPABASE_URL.trim();
const serviceKey = env.SUPABASE_SERVICE_KEY.trim();
const store = createSupabaseStore({ url, serviceKey });
const id = `check-${Date.now()}`;
const ok = (label: string, pass: boolean) => {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) process.exitCode = 1;
};

try {
  ok('처음 기록하면 새로 기록됨(true)', (await store.record('selftest', id, { n: 1 })) === true);
  ok('같은 출처를 다시 기록하면 중복(false)', (await store.record('selftest', id, { n: 2 })) === false);
  ok('has: 있음', (await store.has('selftest', id)) === true);
  ok('has: 다른 id는 없음', (await store.has('selftest', `${id}-x`)) === false);
  const rows = await store.list('selftest', '1970-01-01T00:00:00.000Z');
  ok('list: 방금 기록한 항목이 보임, 첫 값이 유지됨', rows.some((r) => r.id === id && (r.data as { n: number }).n === 1));
  const future = new Date(Date.now() + 60_000).toISOString();
  ok('list: 미래 시각 이후는 비어 있음', (await store.list('selftest', future)).length === 0);
  await store.setState(`selftest-${id}`, 'v1');
  await store.setState(`selftest-${id}`, 'v2');
  ok('상태 저장: 덮어쓰기 후 최신 값', (await store.getState(`selftest-${id}`)) === 'v2');
  ok('상태 저장: 없는 키는 null', (await store.getState(`selftest-none-${id}`)) === null);
} finally {
  // 시험 데이터 정리(이 스크립트가 만든 것만)
  const h = { apikey: serviceKey, authorization: `Bearer ${serviceKey}` };
  const a = await fetch(`${url}/rest/v1/assistant_history?kind=eq.selftest&id=eq.${id}`, { method: 'DELETE', headers: h });
  const b = await fetch(`${url}/rest/v1/assistant_state?key=eq.selftest-${id}`, { method: 'DELETE', headers: h });
  console.log(`정리: history ${a.status}, state ${b.status}`);
}
