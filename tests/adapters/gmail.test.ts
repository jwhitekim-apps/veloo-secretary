import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGmail, extractText } from '../../src/adapters/gmail.ts';

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fakeGoogle(handlers: Record<string, unknown>, opts: { failFirstWith401?: boolean; refreshStatus?: number } = {}) {
  const calls: string[] = [];
  let first = true;
  let refreshes = 0;
  const impl = (async (url: string) => {
    calls.push(url);
    if (url.includes('oauth2.googleapis.com/token')) {
      refreshes += 1;
      if (opts.refreshStatus && opts.refreshStatus !== 200) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: opts.refreshStatus });
      return new Response(JSON.stringify({ access_token: `at-${refreshes}`, expires_in: 3599 }), { status: 200 });
    }
    if (opts.failFirstWith401 && first) {
      first = false;
      return new Response('{}', { status: 401 });
    }
    const key = Object.keys(handlers).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? handlers[key] : {}), { status: key ? 200 : 404 });
  }) as typeof fetch;
  return { calls, impl, refreshes: () => refreshes };
}

const cfg = { clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt-secret' };

test('search lists messages and maps subject, sender, date and snippet from the metadata headers', async () => {
  const g = fakeGoogle({
    '/messages?q=': { messages: [{ id: 'a' }, { id: 'b' }] },
    '/messages/a?format=metadata': {
      snippet: '초록 마감 안내',
      payload: { headers: [{ name: 'subject', value: '[학회] 초록 마감' }, { name: 'From', value: 'org@conf.test' }, { name: 'Date', value: 'Mon, 5 Oct 2026' }] },
    },
    '/messages/b?format=metadata': { snippet: '', payload: { headers: [] } },
  });
  const metas = await createGmail({ ...cfg, fetch: g.impl }).search('newer_than:1d "학회"', 10);
  assert.deepEqual(metas[0], { id: 'a', subject: '[학회] 초록 마감', from: 'org@conf.test', date: 'Mon, 5 Oct 2026', snippet: '초록 마감 안내' });
  assert.deepEqual(metas[1], { id: 'b', subject: '', from: '', date: '', snippet: '' });
  assert.match(g.calls[1], /q=newer_than%3A1d%20%22%ED%95%99%ED%9A%8C%22&maxResults=10/);
});

test('search with no hits returns an empty list', async () => {
  const g = fakeGoogle({ '/messages?q=': {} });
  assert.deepEqual(await createGmail({ ...cfg, fetch: g.impl }).search('x'), []);
});

test('one token refresh serves several calls', async () => {
  const g = fakeGoogle({ '/messages?q=': { messages: [{ id: 'a' }] }, '/messages/a?format=metadata': { payload: { headers: [] } } });
  await createGmail({ ...cfg, fetch: g.impl }).search('x');
  assert.equal(g.refreshes(), 1);
});

test('a 401 triggers one refresh and a retry', async () => {
  const g = fakeGoogle({ '/messages?q=': {} }, { failFirstWith401: true });
  await createGmail({ ...cfg, fetch: g.impl }).search('x');
  assert.equal(g.refreshes(), 2);
});

test('errors carry the status but never the refresh token or client secret', async () => {
  const g = fakeGoogle({}, { refreshStatus: 400 });
  await assert.rejects(
    createGmail({ ...cfg, fetch: g.impl }).search('x'),
    (e: Error) => /refresh failed -> 400 invalid_grant/.test(e.message) && !/rt-secret|csec/.test(e.message),
  );
  const g2 = fakeGoogle({});
  await assert.rejects(createGmail({ ...cfg, fetch: g2.impl }).search('x'), /GET \/messages -> 404/);
});

test('readBody prefers text/plain inside nested multipart messages and decodes base64url', async () => {
  const payload = {
    mimeType: 'multipart/mixed',
    parts: [
      { mimeType: 'multipart/alternative', parts: [
        { mimeType: 'text/plain', body: { data: b64url('초록 마감은 11월 20일 23:59입니다.') } },
        { mimeType: 'text/html', body: { data: b64url('<p>HTML 버전</p>') } },
      ] },
      { mimeType: 'application/pdf', body: {} },
    ],
  };
  const g = fakeGoogle({ '/messages/x?format=full': { payload } });
  assert.equal(await createGmail({ ...cfg, fetch: g.impl }).readBody('x'), '초록 마감은 11월 20일 23:59입니다.');
});

test('readBody falls back to stripped HTML and truncates very long bodies', async () => {
  const html = `<style>p{color:red}</style><p>마감&nbsp;11/20</p><script>x()</script>`;
  assert.equal(extractText({ mimeType: 'text/html', body: { data: b64url(html) } }), '마감 11/20');

  const long = 'a'.repeat(10000);
  const g = fakeGoogle({ '/messages/y?format=full': { payload: { mimeType: 'text/plain', body: { data: b64url(long) } } } });
  assert.equal((await createGmail({ ...cfg, fetch: g.impl }).readBody('y')).length, 6000);
});

test('the client has no send, modify, or delete operation', () => {
  const gmail = createGmail({ ...cfg, fetch: fakeGoogle({}).impl }) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(gmail).sort(), ['readBody', 'search']);
});

const withSubject = (subject: string) => ({ headers: [{ name: 'Subject', value: subject }] });

test('search reports the subject of the first mail in the thread, even when a follow-up carries a different prefix', async () => {
  const g = fakeGoogle({
    '/messages?q=': { messages: [{ id: 'orig' }, { id: 'follow' }] },
    '/messages/orig?format=metadata': { threadId: 't1', payload: withSubject('학회 투고 안내') },
    '/messages/follow?format=metadata': { threadId: 't1', payload: withSubject('[추가 사항 확인 요망] 학회 투고 안내') },
    '/threads/t1?format=metadata': {
      messages: [
        { internalDate: '2000', payload: withSubject('[추가 사항 확인 요망] 학회 투고 안내') },
        { internalDate: '1000', payload: withSubject('학회 투고 안내') },
      ],
    },
  });
  const metas = await createGmail({ ...cfg, fetch: g.impl }).search('x');
  assert.deepEqual(metas.map((m) => m.threadSubject), ['학회 투고 안내', '학회 투고 안내']);
  assert.equal(metas[1].subject, '[추가 사항 확인 요망] 학회 투고 안내');
});

test('a thread is looked up once however many of its mails matched', async () => {
  const g = fakeGoogle({
    '/messages?q=': { messages: [{ id: 'a' }, { id: 'b' }] },
    '/messages/a?format=metadata': { threadId: 't1', payload: withSubject('A') },
    '/messages/b?format=metadata': { threadId: 't1', payload: withSubject('B') },
    '/threads/t1?format=metadata': { messages: [{ internalDate: '1', payload: withSubject('A') }] },
  });
  await createGmail({ ...cfg, fetch: g.impl }).search('x');
  assert.equal(g.calls.filter((u) => u.includes('/threads/')).length, 1);
});

test('when the thread lookup fails the mail is still returned and just has no thread subject', async () => {
  const g = fakeGoogle({
    '/messages?q=': { messages: [{ id: 'a' }] },
    '/messages/a?format=metadata': { threadId: 't9', payload: withSubject('A') },
  });
  const [m] = await createGmail({ ...cfg, fetch: g.impl }).search('x');
  assert.equal(m.subject, 'A');
  assert.equal('threadSubject' in m, false);
});
