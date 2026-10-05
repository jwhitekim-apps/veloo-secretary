// 폴리오(Zotero 논문 뷰어)가 같은 Supabase 프로젝트에 저장한 논문 목록을 읽는다. 읽기 전용이다.
import type { Paper } from '../domain/papers.js';

type FetchLike = typeof fetch;

export function createFolioReader(config: { url: string; serviceKey: string; fetch?: FetchLike }) {
  const doFetch = config.fetch ?? fetch;
  const base = `${config.url.replace(/\/$/, '')}/rest/v1`;

  return {
    async recentPapers(limit = 500): Promise<Paper[]> {
      const res = await doFetch(
        `${base}/folio_papers?select=item_key,title,year,synced_at&order=synced_at.desc&limit=${limit}`,
        { headers: { apikey: config.serviceKey, authorization: `Bearer ${config.serviceKey}` } },
      );
      if (!res.ok) throw new Error(`Folio request failed: GET folio_papers -> ${res.status}`);
      const rows = (await res.json()) as { item_key: string; title: string | null; year: string | null; synced_at: string }[];
      return rows.map((r) => ({ key: r.item_key, title: (r.title ?? '').trim() || '(제목 없음)', year: r.year, syncedAt: r.synced_at }));
    },
  };
}
