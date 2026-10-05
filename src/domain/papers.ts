// 폴리오에서 읽어 온 논문 목록으로 "이번 주 새로 들어온 논문"을 판단한다. 네트워크는 모르고, 저장소는 바깥에서 받는다.
export type Paper = { key: string; title: string; year: string | null; syncedAt: string };

type PaperStore = {
  record(kind: string, id: string, data: unknown, at?: string): Promise<boolean>;
  list(kind: string, sinceIso: string): Promise<{ id: string; at: string; data: unknown }[]>;
};

const EPOCH = '1970-01-01T00:00:00.000Z';
const DAY_MS = 86_400_000;
const SHOWN_TITLES = 3;

// 비서가 처음 본 논문을 기록하고, 최근 windowDays일 안에 들어온 논문의 수와 최근 제목을 돌려준다.
// 폴리오에는 "처음 저장한 시각"이 없으므로(synced_at은 정보를 다시 가져올 때마다 바뀐다) 비서가 처음 본 시각을 기준으로 삼는다.
// 기록이 하나도 없는 첫 실행은 기준만 잡는다: 기존 논문을 모두 새 논문으로 보고하지 않도록, 그때는 synced_at을 기준 시각으로 쓴다.
// dryRun이면 아무것도 기록하지 않고 결과만 계산한다.
export async function trackNewPapers(
  papers: Paper[],
  store: PaperStore,
  now: Date,
  options: { windowDays?: number; dryRun?: boolean } = {},
): Promise<{ count: number; titles: string[] }> {
  const windowStart = new Date(now.getTime() - (options.windowDays ?? 7) * DAY_MS).toISOString();

  const known = await store.list('paper', EPOCH);
  const seen = new Set(known.map((e) => e.id));
  const coldStart = known.length === 0;

  const items = known.map((e) => ({ at: e.at, title: String((e.data as { title?: string } | null)?.title ?? '') }));
  for (const p of papers) {
    if (seen.has(p.key)) continue;
    const at = coldStart ? p.syncedAt : now.toISOString();
    items.push({ at, title: p.title });
    if (!options.dryRun) await store.record('paper', p.key, { title: p.title, year: p.year }, at);
  }

  // 같은 시각(ISO 문자열의 형식이 달라도)을 비교할 수 있게 시각 값으로 바꿔서 거른다.
  const startMs = Date.parse(windowStart);
  const recent = items.filter((i) => Date.parse(i.at) >= startMs).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { count: recent.length, titles: recent.slice(0, SHOWN_TITLES).map((i) => i.title) };
}
