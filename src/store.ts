export type Entry = { kind: string; id: string; at: string; data: unknown };

// 비서의 처리 이력과 작은 상태값(토큰 등)을 저장한다. 서버리스라 메모리에는 둘 수 없다.
export interface Store {
  // 새로 기록하면 true, 같은 (kind, id)가 이미 있으면 false
  record(kind: string, id: string, data: unknown, at?: string): Promise<boolean>;
  has(kind: string, id: string): Promise<boolean>;
  // sinceIso보다 "엄격히 나중"에 기록된 항목만 시간순으로 돌려준다.
  list(kind: string, sinceIso: string): Promise<Entry[]>;
  getState(key: string): Promise<string | null>;
  setState(key: string, value: string): Promise<void>;
}

export function createMemoryStore(now: () => Date = () => new Date()): Store {
  const entries = new Map<string, Entry>();
  const state = new Map<string, string>();
  const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`;

  return {
    async record(kind, id, data, at) {
      const key = keyOf(kind, id);
      if (entries.has(key)) return false;
      entries.set(key, { kind, id, at: at ?? now().toISOString(), data });
      return true;
    },
    async has(kind, id) {
      return entries.has(keyOf(kind, id));
    },
    async list(kind, sinceIso) {
      return [...entries.values()]
        .filter((e) => e.kind === kind && e.at > sinceIso)
        .sort((a, b) => a.at.localeCompare(b.at));
    },
    async getState(key) {
      return state.get(key) ?? null;
    },
    async setState(key, value) {
      state.set(key, value);
    },
  };
}

type FetchLike = typeof fetch;

// Supabase REST(PostgREST)로 supabase/assistant.sql의 테이블을 읽고 쓴다.
export function createSupabaseStore(config: {
  url: string;
  serviceKey: string;
  fetch?: FetchLike;
  now?: () => Date;
}): Store {
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  const base = `${config.url.replace(/\/$/, '')}/rest/v1`;
  const headers = {
    apikey: config.serviceKey,
    authorization: `Bearer ${config.serviceKey}`,
    'content-type': 'application/json',
  };
  const q = encodeURIComponent;

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new Error(`Supabase request failed: ${init.method ?? 'GET'} ${path.split('?')[0]} -> ${res.status}`);
    const text = await res.text();
    return text ? JSON.parse(text) : [];
  }

  return {
    async record(kind, id, data, at) {
      const rows = (await call('/assistant_history?on_conflict=kind,id', {
        method: 'POST',
        headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify({ kind, id, at: at ?? now().toISOString(), data }),
      })) as unknown[];
      return rows.length > 0;
    },
    async has(kind, id) {
      const rows = (await call(`/assistant_history?kind=eq.${q(kind)}&id=eq.${q(id)}&select=id`)) as unknown[];
      return rows.length > 0;
    },
    async list(kind, sinceIso) {
      return (await call(
        `/assistant_history?kind=eq.${q(kind)}&at=gt.${q(sinceIso)}&select=kind,id,at,data&order=at.asc`,
      )) as Entry[];
    },
    async getState(key) {
      const rows = (await call(`/assistant_state?key=eq.${q(key)}&select=value`)) as { value: string }[];
      return rows[0]?.value ?? null;
    },
    async setState(key, value) {
      await call('/assistant_state?on_conflict=key', {
        method: 'POST',
        headers: { prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify({ key, value, updated_at: now().toISOString() }),
      });
    },
  };
}
