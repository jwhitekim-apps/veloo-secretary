// 카카오톡 "나에게 보내기" 전송. 액세스 토큰은 약 6시간이라, 만료되면 리프레시 토큰으로 갱신한다.
export const KAKAO_TEXT_LIMIT = 200;

type StateStore = {
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
};

const REFRESH_KEY = 'kakao_refresh';
const ACCESS_KEY = 'kakao_access';

export function createKakao(config: {
  restApiKey: string;
  clientSecret?: string;
  refreshToken: string;
  linkUrl: string;
  store?: StateStore;
  fetch?: typeof fetch;
  now?: () => Date;
}) {
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  let access: { token: string; expiresAt: number } | null = null;

  async function refresh(): Promise<string> {
    // 갱신 때 새 리프레시 토큰이 같이 오면 저장소에 둔 것이 환경 변수의 시작값보다 우선한다.
    const refreshToken = (await config.store?.getState(REFRESH_KEY)) ?? config.refreshToken;
    const params: Record<string, string> = {
      grant_type: 'refresh_token',
      client_id: config.restApiKey,
      refresh_token: refreshToken,
    };
    if (config.clientSecret) params.client_secret = config.clientSecret;

    const res = await doFetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params),
    });
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      refresh_token?: string;
      error?: string;
      error_code?: string;
    };
    if (!res.ok || !body.access_token) {
      throw new Error(`Kakao token refresh failed -> ${res.status} ${body.error ?? ''} ${body.error_code ?? ''}`.trim());
    }
    access = { token: body.access_token, expiresAt: now().getTime() + (body.expires_in ?? 3600) * 1000 };
    await config.store?.setState(ACCESS_KEY, JSON.stringify(access));
    if (body.refresh_token) await config.store?.setState(REFRESH_KEY, body.refresh_token);
    return access.token;
  }

  async function accessToken(): Promise<string> {
    const fresh = (a: { token: string; expiresAt: number } | null) => a && a.expiresAt - 60_000 > now().getTime();
    if (fresh(access)) return access!.token;
    const saved = await config.store?.getState(ACCESS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as { token: string; expiresAt: number };
      if (fresh(parsed)) {
        access = parsed;
        return parsed.token;
      }
    }
    return refresh();
  }

  async function post(token: string, text: string): Promise<Response> {
    const template = { object_type: 'text', text, link: { web_url: config.linkUrl, mobile_web_url: config.linkUrl } };
    return doFetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams({ template_object: JSON.stringify(template) }),
    });
  }

  return {
    async send(text: string): Promise<void> {
      let res = await post(await accessToken(), text);
      if (res.status === 401) {
        // 토큰이 만료됐으면 한 번만 갱신해서 다시 보낸다.
        res = await post(await refresh(), text);
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: number; msg?: string };
        throw new Error(`Kakao send failed -> ${res.status} ${body.code ?? ''} ${body.msg ?? ''}`.trim());
      }
    },
  };
}
