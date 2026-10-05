import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../../src/adapters/store.ts';
import { createKakao } from '../../src/adapters/kakao.ts';

type Call = { url: string; init: RequestInit };

function fakeKakao(opts: { sendStatuses?: number[]; refreshStatus?: number; rotate?: boolean } = {}) {
  const calls: Call[] = [];
  const sendStatuses = [...(opts.sendStatuses ?? [200])];
  let refreshCount = 0;
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    if (url.includes('/oauth/token')) {
      refreshCount += 1;
      if ((opts.refreshStatus ?? 200) !== 200) {
        return new Response(JSON.stringify({ error: 'invalid_grant', error_code: 'KOE320' }), { status: opts.refreshStatus });
      }
      const body: Record<string, unknown> = { access_token: `access-${refreshCount}`, expires_in: 21599 };
      if (opts.rotate) body.refresh_token = `refresh-rotated-${refreshCount}`;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    const status = sendStatuses.shift() ?? 200;
    return new Response(JSON.stringify(status === 200 ? { result_code: 0 } : { code: -401, msg: 'expired' }), { status });
  }) as typeof fetch;
  return { calls, impl, refreshes: () => refreshCount };
}

const base = { restApiKey: 'REST', refreshToken: 'refresh-0', linkUrl: 'https://example.test' };
const sends = (calls: Call[]) => calls.filter((c) => c.url.includes('talk/memo'));
const tokens = (calls: Call[]) => calls.filter((c) => c.url.includes('/oauth/token'));
const textOf = (c: Call) => JSON.parse(new URLSearchParams(c.init.body as URLSearchParams).get('template_object')!).text;

test('sends the text as a text template after obtaining an access token', async () => {
  const f = fakeKakao();
  await createKakao({ ...base, fetch: f.impl }).send('안녕');
  const send = sends(f.calls)[0];
  assert.equal((send.init.headers as Record<string, string>).authorization, 'Bearer access-1');
  assert.equal(textOf(send), '안녕');
});

test('an access token rejected as expired is refreshed and the message is sent again', async () => {
  const f = fakeKakao({ sendStatuses: [401, 200] });
  await createKakao({ ...base, fetch: f.impl }).send('hi');
  assert.equal(sends(f.calls).length, 2);
  assert.equal((sends(f.calls)[1].init.headers as Record<string, string>).authorization, 'Bearer access-2');
});

test('the access token is reused across sends instead of refreshing every time', async () => {
  const f = fakeKakao();
  const kakao = createKakao({ ...base, fetch: f.impl });
  await kakao.send('a');
  await kakao.send('b');
  assert.equal(f.refreshes(), 1);
});

test('an expired cached access token is refreshed before sending', async () => {
  const f = fakeKakao();
  let clock = new Date('2026-10-07T00:00:00Z').getTime();
  const kakao = createKakao({ ...base, fetch: f.impl, now: () => new Date(clock) });
  await kakao.send('a');
  clock += 7 * 3600 * 1000; // 7시간 뒤
  await kakao.send('b');
  assert.equal(f.refreshes(), 2);
});

test('a rotated refresh token is stored and used for the next refresh', async () => {
  const f = fakeKakao({ rotate: true });
  const store = createMemoryStore();
  await createKakao({ ...base, store, fetch: f.impl }).send('a');
  assert.equal(await store.getState('kakao_refresh'), 'refresh-rotated-1');

  // 새 인스턴스(다음 날의 서버리스 호출)는 환경 변수가 아니라 저장된 토큰으로 갱신한다.
  await store.setState('kakao_access', JSON.stringify({ token: 'old', expiresAt: 0 }));
  await createKakao({ ...base, store, fetch: f.impl }).send('b');
  const secondRefresh = tokens(f.calls)[1];
  assert.equal(new URLSearchParams(secondRefresh.init.body as URLSearchParams).get('refresh_token'), 'refresh-rotated-1');
});

test('the client secret is sent only when configured', async () => {
  const f = fakeKakao();
  await createKakao({ ...base, fetch: f.impl }).send('a');
  assert.equal(new URLSearchParams(tokens(f.calls)[0].init.body as URLSearchParams).has('client_secret'), false);

  const g = fakeKakao();
  await createKakao({ ...base, clientSecret: 'SEC', fetch: g.impl }).send('a');
  assert.equal(new URLSearchParams(tokens(g.calls)[0].init.body as URLSearchParams).get('client_secret'), 'SEC');
});

test('a refresh failure raises an error with the status and never contains tokens', async () => {
  const f = fakeKakao({ refreshStatus: 400 });
  await assert.rejects(
    createKakao({ ...base, fetch: f.impl }).send('a'),
    (e: Error) => /refresh failed -> 400 invalid_grant KOE320/.test(e.message) && !e.message.includes('refresh-0'),
  );
  assert.equal(sends(f.calls).length, 0);
});

test('a send failure after the retry is reported, not swallowed', async () => {
  const f = fakeKakao({ sendStatuses: [401, 401] });
  await assert.rejects(createKakao({ ...base, fetch: f.impl }).send('a'), /send failed -> 401/);
});
