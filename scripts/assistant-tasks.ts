// 비서가 만든 태스크가 벨루에 지금 어떤 상태로 있는지 보여 준다(읽기 전용).
// 벨루 메모에는 내부 표식을 남기지 않으므로, 어떤 태스크를 비서가 만들었는지는 처리 기록(Supabase)의 태스크 번호로 안다.
// 실행: npm run assistant:tasks
import { createSupabaseStore } from '../src/adapters/store.js';
import { createVelooClient } from '../src/adapters/veloo.js';
import { loadEnvLocal } from './load-env.js';

const env = loadEnvLocal();
const store = createSupabaseStore({ url: env.SUPABASE_URL.trim(), serviceKey: env.SUPABASE_SERVICE_KEY.trim() });
const veloo = createVelooClient({
  baseUrl: env.VELOO_BASE_URL.trim(),
  username: env.VELOO_USERNAME.trim(),
  password: env.VELOO_PASSWORD.trim(),
});

const since = '1970-01-01T00:00:00.000Z';
const made = new Map<number, string>();
for (const kind of ['intake', 'mail']) {
  for (const entry of await store.list(kind, since)) {
    const id = (entry.data as { taskId?: unknown }).taskId;
    if (typeof id === 'number') made.set(id, kind === 'mail' ? '메일' : '폰 입력');
  }
}

const tasks = new Map((await veloo.listTasks()).map((t) => [t.id, t]));
const alive = [...made].filter(([id]) => tasks.has(id));
const gone = [...made].filter(([id]) => !tasks.has(id));

console.log(`비서가 만든 태스크 ${made.size}건 중 벨루에 지금 있는 것 ${alive.length}건, 지워진 것 ${gone.length}건\n`);
for (const [id, from] of alive) {
  const t = tasks.get(id)!;
  console.log(`  #${id} [${from}] ${t.name} | 마감 ${t.deadline || '없음'}${t.done ? ' | 완료' : ''}`);
}
