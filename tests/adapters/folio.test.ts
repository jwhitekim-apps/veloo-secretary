import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFolioReader } from '../../src/adapters/folio.ts';

test('the reader asks for the newest papers and maps the rows', async () => {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> });
    return new Response(
      JSON.stringify([
        { item_key: 'A', title: ' OpenHands ', year: '2025', synced_at: '2026-10-04T11:21:33+00:00' },
        { item_key: 'B', title: null, year: null, synced_at: '2026-09-17T04:42:30+00:00' },
      ]),
      { status: 200 },
    );
  }) as typeof fetch;
  const papers = await createFolioReader({ url: 'https://x.supabase.co/', serviceKey: 'KEY', fetch: impl }).recentPapers(50);
  assert.deepEqual(papers, [
    { key: 'A', title: 'OpenHands', year: '2025', syncedAt: '2026-10-04T11:21:33+00:00' },
    { key: 'B', title: '(제목 없음)', year: null, syncedAt: '2026-09-17T04:42:30+00:00' },
  ]);
  assert.equal(calls[0].url, 'https://x.supabase.co/rest/v1/folio_papers?select=item_key,title,year,synced_at&order=synced_at.desc&limit=50');
  assert.equal(calls[0].headers.apikey, 'KEY');
});

test('a failed read raises an error with the status and no key', async () => {
  const impl = (async () => new Response('{}', { status: 404 })) as typeof fetch;
  await assert.rejects(
    createFolioReader({ url: 'https://x.supabase.co', serviceKey: 'SECRET-KEY', fetch: impl }).recentPapers(),
    (e: Error) => /-> 404/.test(e.message) && !e.message.includes('SECRET-KEY'),
  );
});
