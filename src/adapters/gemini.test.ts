import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickModel, withFallback } from './gemini.ts';

const cfg = { model: 'flash', highModel: 'pro' };

test('text always uses the main model, even when high quality is requested', () => {
  assert.equal(pickModel(cfg, { hasImage: false, high: false }), 'flash');
  assert.equal(pickModel(cfg, { hasImage: false, high: true }), 'flash');
});

test('an ordinary image (e.g. a screenshot) uses the main model', () => {
  assert.equal(pickModel(cfg, { hasImage: true, high: false }), 'flash');
});

test('only an image that asks for high quality uses the high model', () => {
  assert.equal(pickModel(cfg, { hasImage: true, high: true }), 'pro');
});

test('without a high model, or with a blank one, high quality falls back to the main model', () => {
  assert.equal(pickModel({ model: 'flash' }, { hasImage: true, high: true }), 'flash');
  assert.equal(pickModel({ model: 'flash', highModel: '' }, { hasImage: true, high: true }), 'flash');
  assert.equal(pickModel({ model: 'flash', highModel: '  ' }, { hasImage: true, high: true }), 'flash');
});

test('surrounding whitespace in the high model name is ignored', () => {
  assert.equal(pickModel({ model: 'flash', highModel: ' pro \n' }, { hasImage: true, high: true }), 'pro');
});

test('withFallback returns the first model that works and stops there', async () => {
  const tried: string[] = [];
  const result = await withFallback(['pro', 'flash'], async (m) => { tried.push(m); return `ok-${m}`; });
  assert.equal(result, 'ok-pro');
  assert.deepEqual(tried, ['pro']);
});

test('withFallback tries the next model when the first fails', async () => {
  const tried: string[] = [];
  const result = await withFallback(['pro', 'flash'], async (m) => {
    tried.push(m);
    if (m === 'pro') throw new Error('model retired');
    return `ok-${m}`;
  });
  assert.equal(result, 'ok-flash');
  assert.deepEqual(tried, ['pro', 'flash']);
});

test('withFallback raises the last error when every model fails', async () => {
  await assert.rejects(
    withFallback(['pro', 'flash'], async (m) => { throw new Error(`${m} failed`); }),
    /flash failed/,
  );
});
