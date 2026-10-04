// 실제 서비스(Gemini, Gmail, 카카오, 벨루, Supabase)를 환경 변수로 연결한다.
// 테스트하지 않는 얇은 배선이며, 로직은 모두 다른 모듈에 있다.
import { randomUUID } from 'node:crypto';
import { requireEnv } from './config.js';
import { runDaily } from './daily.js';
import { createGenerateJson } from './gemini.js';
import { createGmail } from './gmail.js';
import { processIntake } from './intake-flow.js';
import { interpretInput } from './interpret.js';
import { createKakao, KAKAO_TEXT_LIMIT } from './kakao.js';
import { syncCandidates } from './ledger.js';
import { triageMail } from './mail.js';
import { createMemoryStore, createSupabaseStore } from './store.js';
import { createVelooClient } from './veloo.js';

type Env = Record<string, string | undefined>;

const LINK_URL = 'https://personal-secretary-kappa.vercel.app';

// SUPABASE_URL과 SUPABASE_SERVICE_KEY가 있으면 영구 저장소를, 없으면 이번 호출 동안만 유지되는 메모리를 쓴다.
function buildStore(env: Env) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    return { store: createSupabaseStore({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY }), durable: true };
  }
  return { store: createMemoryStore(), durable: false };
}

function buildVeloo(env: Env, store: ReturnType<typeof buildStore>['store']) {
  const e = requireEnv(env, ['VELOO_BASE_URL', 'VELOO_USERNAME', 'VELOO_PASSWORD']);
  return createVelooClient({ baseUrl: e.VELOO_BASE_URL, username: e.VELOO_USERNAME, password: e.VELOO_PASSWORD, store });
}

function buildGenerateJson(env: Env) {
  const e = requireEnv(env, ['GEMINI_API_KEY', 'GEMINI_MODEL']);
  return createGenerateJson({ apiKey: e.GEMINI_API_KEY, model: e.GEMINI_MODEL });
}

export function createIntakeHandler(env: Env) {
  const { store } = buildStore(env);
  const generateJson = buildGenerateJson(env);
  const veloo = buildVeloo(env, store);
  return (input: unknown, options: { dryRun?: boolean } = {}) =>
    processIntake(
      input,
      {
        interpret: (i) => interpretInput(i, { generateJson, now: new Date() }),
        sync: (candidates, source) => syncCandidates(candidates, source, { veloo, store }),
        store,
        newId: randomUUID,
      },
      options,
    );
}

export function createDailyRunner(env: Env) {
  const { store, durable } = buildStore(env);
  const generateJson = buildGenerateJson(env);
  const veloo = buildVeloo(env, store);
  const gmailEnv = requireEnv(env, ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'MAIL_KEYWORDS']);
  const kakaoEnv = requireEnv(env, ['KAKAO_REST_API_KEY', 'KAKAO_REFRESH_TOKEN']);

  const gmail = createGmail({
    clientId: gmailEnv.GMAIL_CLIENT_ID,
    clientSecret: gmailEnv.GMAIL_CLIENT_SECRET,
    refreshToken: gmailEnv.GMAIL_REFRESH_TOKEN,
  });
  const kakao = createKakao({
    restApiKey: kakaoEnv.KAKAO_REST_API_KEY,
    clientSecret: env.KAKAO_CLIENT_SECRET || undefined,
    refreshToken: kakaoEnv.KAKAO_REFRESH_TOKEN,
    linkUrl: LINK_URL,
    store,
  });
  const keywords = gmailEnv.MAIL_KEYWORDS.split(',').map((k) => k.trim()).filter(Boolean);
  const lookbackDays = Number(env.MAIL_LOOKBACK_DAYS) || 2;

  return (options: { dryRun?: boolean } = {}) => {
    const now = new Date();
    return runDaily({
      now,
      store,
      veloo,
      kakao,
      mail: () =>
        triageMail({
          gmail,
          generateJson,
          interpret: (text) => interpretInput({ text }, { generateJson, now }),
          store,
          keywords,
          lookbackDays,
        }),
      sync: (candidates, source) => syncCandidates(candidates, source, { veloo, store }),
      limit: KAKAO_TEXT_LIMIT,
      notes: durable ? [] : ['저장소가 설정되지 않아 처리 이력과 갱신된 토큰이 유지되지 않아요'],
      dryRun: options.dryRun,
    });
  };
}
