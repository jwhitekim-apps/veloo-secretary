import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createMemoryStore } from './store.ts';
import { createVelooClient } from './veloo.ts';

// 벨루 백엔드(app/auth.py, app/todo/core/routers/todos.py)의 모양을 흉내 낸 가짜 서버
function startFakeVeloo() {
  const tasks: Record<string, unknown>[] = [];
  const state = { logins: 0, validToken: '', nextId: 1 };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const json = (status: number, payload: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/login' && req.method === 'POST') {
        if (body.username !== 'bot' || body.password !== 'pw-123456') return json(401, { error: 'bad credentials' });
        state.logins += 1;
        state.validToken = `tok${state.logins}`;
        return json(200, { ok: true }, { 'set-cookie': [`access_token=${state.validToken}; HttpOnly; Path=/`] });
      }
      if (req.headers.cookie !== `access_token=${state.validToken}` || !state.validToken) {
        return json(401, { error: 'session expired' });
      }
      if (req.url === '/todo/api/todos' && req.method === 'GET') return json(200, tasks);
      if (req.url === '/todo/api/todos' && req.method === 'POST') {
        const task = { id: state.nextId++, done: false, ...body };
        tasks.push(task);
        return json(200, task);
      }
      json(404, { error: 'not found' });
    });
  });
  return new Promise<{ url: string; state: typeof state; tasks: typeof tasks; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        state,
        tasks,
        close: () => server.close(),
      });
    });
  });
}

const credentials = { username: 'bot', password: 'pw-123456' };

test('logs in with the session cookie, creates a task, and lists it back', async () => {
  const fake = await startFakeVeloo();
  try {
    const veloo = createVelooClient({ baseUrl: fake.url, ...credentials });
    const created = await veloo.createTask({ name: 'A', memo: 'm', priority: 'normal', deadline: '2026-10-09' });
    assert.equal(created.name, 'A');
    const list = await veloo.listTasks();
    assert.deepEqual(list.map((t) => t.name), ['A']);
    assert.equal(fake.state.logins, 1, 'one login serves both calls');
  } finally {
    fake.close();
  }
});

test('an expired session triggers exactly one re-login and the request succeeds', async () => {
  const fake = await startFakeVeloo();
  try {
    const veloo = createVelooClient({ baseUrl: fake.url, ...credentials });
    await veloo.listTasks();
    fake.state.validToken = 'rotated-on-server'; // 서버가 기존 세션을 무효화한 상황
    await veloo.listTasks();
    assert.equal(fake.state.logins, 2);
  } finally {
    fake.close();
  }
});

test('a wrong password fails with the status code and never echoes the password', async () => {
  const fake = await startFakeVeloo();
  try {
    const veloo = createVelooClient({ baseUrl: fake.url, username: 'bot', password: 'wrong-pass-999' });
    await assert.rejects(veloo.listTasks(), (e: Error) => /login failed -> 401/.test(e.message) && !e.message.includes('wrong-pass-999'));
  } finally {
    fake.close();
  }
});

test('the session is reused from the store, so a fresh client does not log in again', async () => {
  const fake = await startFakeVeloo();
  try {
    const store = createMemoryStore();
    await createVelooClient({ baseUrl: fake.url, ...credentials, store }).listTasks();
    await createVelooClient({ baseUrl: fake.url, ...credentials, store }).listTasks();
    assert.equal(fake.state.logins, 1);
  } finally {
    fake.close();
  }
});

test('an unreachable server surfaces as an error instead of being swallowed', async () => {
  const veloo = createVelooClient({ baseUrl: 'http://127.0.0.1:9', ...credentials });
  await assert.rejects(veloo.listTasks());
});

test('the client exposes no update or delete operation', () => {
  const veloo = createVelooClient({ baseUrl: 'http://127.0.0.1:9', ...credentials }) as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(veloo).sort(), ['createTask', 'listTasks']);
});
