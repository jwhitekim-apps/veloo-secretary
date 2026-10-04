// 카카오 토큰 복구 점검(task 1.4, 6.3): 만료된 액세스 토큰으로 시작해도 갱신 후 전송에 성공하는지 확인한다.
// 본인 카톡으로 메시지 한 통이 실제로 전송된다.
import { createKakao } from '../src/kakao.js';
import { createMemoryStore } from '../src/store.js';
import { loadEnvLocal } from './load-env.js';

const env = loadEnvLocal();
const store = createMemoryStore();
// 아직 유효한 것처럼 보이지만 서버는 모르는 토큰
await store.setState('kakao_access', JSON.stringify({ token: 'expired-on-purpose', expiresAt: Date.now() + 3600_000 }));

let sawUnauthorized = false;
const loggingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  if (String(input).includes('talk/memo') && res.status === 401) sawUnauthorized = true;
  return res;
};

const kakao = createKakao({
  restApiKey: env.KAKAO_REST_API_KEY,
  clientSecret: env.KAKAO_CLIENT_SECRET || undefined,
  refreshToken: env.KAKAO_REFRESH_TOKEN,
  linkUrl: 'https://personal-secretary-kappa.vercel.app',
  store,
  fetch: loggingFetch,
});
await kakao.send('[비서] 만료된 토큰에서 갱신으로 복구해 전송한 시험 메시지입니다.');
console.log('만료 토큰으로 먼저 거부됨(401):', sawUnauthorized);
console.log('갱신 후 전송 성공: true');
console.log('새 액세스 토큰이 저장소에 저장됨:', Boolean(JSON.parse((await store.getState('kakao_access'))!).token !== 'expired-on-purpose'));
