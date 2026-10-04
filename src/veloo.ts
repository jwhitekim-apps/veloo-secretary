export type VelooTask = {
  id: number;
  name: string;
  memo: string;
  priority: string;
  deadline: string;
  done: boolean;
};
export type NewTask = { name: string; memo: string; priority: string; deadline: string };

// 비서가 벨루에 대해 할 수 있는 일은 읽기와 생성뿐이다. 수정·삭제는 일부러 만들지 않았다(위임 정책).
export interface Veloo {
  listTasks(): Promise<VelooTask[]>;
  createTask(task: NewTask): Promise<VelooTask>;
}

type SessionStore = {
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
};

const SESSION_KEY = 'veloo_session';

export function createVelooClient(config: {
  baseUrl: string;
  username: string;
  password: string;
  store?: SessionStore;
  fetch?: typeof fetch;
}): Veloo {
  const doFetch = config.fetch ?? fetch;
  const base = config.baseUrl.replace(/\/$/, '');
  let cookie: string | null = null;

  async function login(): Promise<string> {
    const res = await doFetch(`${base}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: config.username, password: config.password }),
    });
    if (!res.ok) throw new Error(`Veloo login failed -> ${res.status}`);
    const token = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .find((c) => c.startsWith('access_token='));
    if (!token) throw new Error('Veloo login returned no session cookie');
    cookie = token;
    await config.store?.setState(SESSION_KEY, token);
    return token;
  }

  async function session(): Promise<string> {
    if (cookie) return cookie;
    const saved = await config.store?.getState(SESSION_KEY);
    if (saved) {
      cookie = saved;
      return saved;
    }
    return login();
  }

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const send = async (current: string) =>
      doFetch(`${base}${path}`, {
        ...init,
        headers: { ...init.headers, cookie: current, 'content-type': 'application/json' },
      });

    let res = await send(await session());
    if (res.status === 401) {
      // 세션이 만료됐으면 한 번만 다시 로그인한다.
      res = await send(await login());
    }
    if (!res.ok) throw new Error(`Veloo request failed: ${init.method ?? 'GET'} ${path} -> ${res.status}`);
    return res;
  }

  return {
    async listTasks() {
      return (await (await request('/todo/api/todos')).json()) as VelooTask[];
    },
    async createTask(task) {
      const res = await request('/todo/api/todos', { method: 'POST', body: JSON.stringify(task) });
      return (await res.json()) as VelooTask;
    },
  };
}
