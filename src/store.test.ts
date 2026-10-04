import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore, createSupabaseStore } from './store.ts';

test('memory store: the second record of the same source is reported as already processed', async () => {
  const store = createMemoryStore();
  assert.equal(await store.record('mail', 'm1#0', { a: 1 }), true);
  assert.equal(await store.record('mail', 'm1#0', { a: 2 }), false);
  assert.equal(await store.has('mail', 'm1#0'), true);
  assert.equal(await store.has('mail', 'm2#0'), false);
  assert.equal(await store.has('intake', 'm1#0'), false, 'kinds are separate namespaces');
});

test('memory store: list returns only entries of that kind strictly after the cutoff, oldest first', async () => {
  const store = createMemoryStore();
  await store.record('mail', 'old', {}, '2026-10-01T00:00:00.000Z');
  await store.record('mail', 'b', {}, '2026-10-06T00:00:00.000Z');
  await store.record('mail', 'a', {}, '2026-10-05T00:00:00.000Z');
  await store.record('intake', 'x', {}, '2026-10-06T00:00:00.000Z');
  const rows = await store.list('mail', '2026-10-02T00:00:00.000Z');
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b']);
});

test('memory store: state values round-trip and missing keys are null', async () => {
  const store = createMemoryStore();
  assert.equal(await store.getState('k'), null);
  await store.setState('k', 'v1');
  await store.setState('k', 'v2');
  assert.equal(await store.getState('k'), 'v2');
});

function fakeFetch(responder: (url: string, init: RequestInit) => { status?: number; body: unknown }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const { status = 200, body } = responder(url, init);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, impl };
}

test('supabase store: record inserts with ignore-duplicates and reports duplicates from the empty response', async () => {
  let rows: unknown[] = [{ kind: 'mail', id: 'm1' }];
  const { calls, impl } = fakeFetch(() => ({ body: rows }));
  const store = createSupabaseStore({ url: 'https://x.supabase.co/', serviceKey: 'KEY', fetch: impl });

  assert.equal(await store.record('mail', 'm1', { n: 1 }), true);
  rows = [];
  assert.equal(await store.record('mail', 'm1', { n: 1 }), false);

  const first = calls[0];
  assert.equal(first.url, 'https://x.supabase.co/rest/v1/assistant_history?on_conflict=kind,id');
  assert.equal(first.init.method, 'POST');
  const headers = first.init.headers as Record<string, string>;
  assert.equal(headers.apikey, 'KEY');
  assert.equal(headers.authorization, 'Bearer KEY');
  assert.match(headers.prefer, /ignore-duplicates/);
  const body = JSON.parse(first.init.body as string);
  assert.equal(body.kind, 'mail');
  assert.equal(body.id, 'm1');
  assert.deepEqual(body.data, { n: 1 });
});

test('supabase store: has, list and state use encoded filters', async () => {
  const { calls, impl } = fakeFetch((url) => {
    if (url.includes('assistant_state')) return { body: [{ value: 'tok' }] };
    return { body: [{ kind: 'mail', id: 'a b', at: '2026-10-05T00:00:00Z', data: {} }] };
  });
  const store = createSupabaseStore({ url: 'https://x.supabase.co', serviceKey: 'KEY', fetch: impl });

  assert.equal(await store.has('mail', 'a b'), true);
  assert.match(calls[0].url, /kind=eq\.mail&id=eq\.a%20b&select=id/);

  const rows = await store.list('mail', '2026-10-01T00:00:00Z');
  assert.equal(rows.length, 1);
  assert.match(calls[1].url, /at=gt\.2026-10-01T00%3A00%3A00Z/);

  assert.equal(await store.getState('kakao_refresh'), 'tok');
  assert.match(calls[2].url, /assistant_state\?key=eq\.kakao_refresh&select=value/);
});

test('supabase store: setState upserts and errors never include the service key', async () => {
  const { calls, impl } = fakeFetch(() => ({ status: 500, body: { message: 'boom' } }));
  const store = createSupabaseStore({ url: 'https://x.supabase.co', serviceKey: 'SECRET-KEY', fetch: impl });
  await assert.rejects(store.setState('k', 'v'), (e: Error) => /-> 500/.test(e.message) && !e.message.includes('SECRET-KEY'));
  assert.match(calls[0].url, /assistant_state\?on_conflict=key/);
  assert.match((calls[0].init.headers as Record<string, string>).prefer, /merge-duplicates/);
});
