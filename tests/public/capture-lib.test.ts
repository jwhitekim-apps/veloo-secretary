import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTAKE_URL,
  buildBody,
  classifyPaste,
  exclusive,
  fitWithin,
  forgetSecret,
  interpretResponse,
  isTextField,
  readSecret,
  saveSecret,
  sendToIntake,
  stripDataUrl,
} from '../../public/capture-lib.js';

test('a wide capture is scaled down to 1600px wide, keeping its proportions', () => {
  assert.deepEqual(fitWithin(2560, 1440), { width: 1600, height: 900 });
  assert.deepEqual(fitWithin(3840, 2160), { width: 1600, height: 900 });
});

test('a small capture is never enlarged', () => {
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 });
  assert.deepEqual(fitWithin(1600, 900), { width: 1600, height: 900 });
});

test('a very flat image keeps at least one pixel of height, and a zero size is rejected', () => {
  assert.deepEqual(fitWithin(8000, 1), { width: 1600, height: 1 });
  assert.throws(() => fitWithin(0, 100), /invalid image size/);
  assert.throws(() => fitWithin(100, Number.NaN), /invalid image size/);
});

test('stripDataUrl keeps only the base64 part', () => {
  assert.equal(stripDataUrl('data:image/jpeg;base64,AAAA'), 'AAAA');
  assert.equal(stripDataUrl('AAAA'), 'AAAA');
});

test('buildBody matches the server contract: text, or image with its mime type', () => {
  assert.deepEqual(buildBody({ text: '  내일까지 보고서 제출 ' }), { text: '내일까지 보고서 제출' });
  assert.deepEqual(buildBody({ jpegBase64: 'AAAA' }), { image: 'AAAA', mimeType: 'image/jpeg' });
  assert.deepEqual(buildBody({ text: '무시됨', jpegBase64: 'AAAA' }), { image: 'AAAA', mimeType: 'image/jpeg' });
});

test('there is nothing to send when the text is blank and there is no image', () => {
  assert.equal(buildBody({ text: '   ' }), null);
  assert.equal(buildBody({}), null);
  assert.equal(buildBody(), null);
});

test('a paste is classified as image first, then text, otherwise nothing usable', () => {
  assert.deepEqual(classifyPaste([{ kind: 'string', type: 'text/plain' }, { kind: 'file', type: 'image/png' }]), { kind: 'image', index: 1 });
  assert.deepEqual(classifyPaste([{ kind: 'string', type: 'text/plain' }]), { kind: 'text' });
  assert.deepEqual(classifyPaste([{ kind: 'file', type: 'application/pdf' }]), { kind: 'none' });
  assert.deepEqual(classifyPaste([]), { kind: 'none' });
  assert.deepEqual(classifyPaste(undefined), { kind: 'none' });
});

test('response status codes map to accepted, unauthorized and error results', () => {
  assert.equal(interpretResponse(202).kind, 'accepted');
  assert.match(interpretResponse(202).message, /카톡/);
  assert.equal(interpretResponse(200).kind, 'accepted');
  assert.equal(interpretResponse(401, '오류: unauthorized').kind, 'unauthorized');
  assert.equal(interpretResponse(400, '오류: text or image is required').kind, 'error');
  assert.match(interpretResponse(400, '오류: text or image is required').message, /text or image is required/);
  assert.match(interpretResponse(500).message, /서버 오류\(500\)/);
});

test('a long error body is clipped so it cannot flood the page', () => {
  assert.ok(interpretResponse(500, 'x'.repeat(500)).message.length < 160);
});

test('sendToIntake posts JSON with the bearer secret to the async text endpoint', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response('접수', { status: 202 });
  }) as unknown as typeof fetch;
  const result = await sendToIntake({ text: '내일까지 보고서' }, 's3cret', fetchImpl);
  assert.equal(result.kind, 'accepted');
  assert.equal(calls[0].url, INTAKE_URL);
  assert.equal(INTAKE_URL, '/api/intake?async=1&format=text');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(calls[0].init.headers, { authorization: 'Bearer s3cret', 'content-type': 'application/json' });
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { text: '내일까지 보고서' });
});

test('sendToIntake reports a rejected secret and a network failure as results instead of throwing', async () => {
  const rejected = (async () => new Response('오류: unauthorized', { status: 401 })) as unknown as typeof fetch;
  assert.equal((await sendToIntake({ text: 'x' }, 'bad', rejected)).kind, 'unauthorized');
  const offline = (async () => {
    throw new TypeError('Failed to fetch');
  }) as unknown as typeof fetch;
  const result = await sendToIntake({ text: 'x' }, 's', offline);
  assert.equal(result.kind, 'error');
  assert.match(result.message, /네트워크.*Failed to fetch/);
});

test('exclusive ignores a second call while the first is still running, then accepts the next one', async () => {
  let release: () => void = () => {};
  let started = 0;
  const run = exclusive(async () => {
    started += 1;
    await new Promise<void>((resolve) => (release = resolve));
    return 'done';
  });
  const first = run();
  assert.deepEqual(await run(), { skipped: true });
  release();
  assert.deepEqual(await first, { skipped: false, value: 'done' });
  const third = run();
  release();
  assert.deepEqual(await third, { skipped: false, value: 'done' });
  assert.equal(started, 2);
});

test('exclusive lets the next call through even after the task threw', async () => {
  let calls = 0;
  const run = exclusive(async () => {
    calls += 1;
    if (calls === 1) throw new Error('boom');
    return 'ok';
  });
  await assert.rejects(run(), /boom/);
  assert.deepEqual(await run(), { skipped: false, value: 'ok' });
});

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

test('the secret is saved once, read back, and forgotten when the server rejects it', () => {
  const storage = memoryStorage();
  assert.equal(readSecret(storage), '');
  assert.equal(saveSecret(storage, 'abc'), true);
  assert.equal(readSecret(storage), 'abc');
  forgetSecret(storage);
  assert.equal(readSecret(storage), '');
});

test('blocked browser storage never throws: reads give nothing and a save reports failure', () => {
  const blocked = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('denied');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  };
  assert.equal(readSecret(blocked), '');
  assert.equal(saveSecret(blocked, 'abc'), false);
  assert.doesNotThrow(() => forgetSecret(blocked));
  assert.equal(readSecret(undefined), '');
});

test('a paste into any text field is left to the browser, so the secret field is not hijacked', () => {
  assert.equal(isTextField('INPUT'), true);
  assert.equal(isTextField('textarea'), true);
  assert.equal(isTextField('BODY'), false);
  assert.equal(isTextField('BUTTON'), false);
  assert.equal(isTextField(undefined), false);
});
