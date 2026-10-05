import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../adapters/store.ts';
import { trackNewPapers, type Paper } from './papers.ts';

const NOW = new Date('2026-10-05T00:00:00Z');
const paper = (key: string, title: string, syncedAt: string): Paper => ({ key, title, year: null, syncedAt });

test('first run: only papers synced within the week count, and every paper is recorded as seen', async () => {
  const store = createMemoryStore(() => NOW);
  const papers = [
    paper('new', 'OpenHands', '2026-10-04T11:21:33Z'),
    paper('old1', 'Attention Is All You Need', '2026-09-17T04:42:30Z'),
    paper('old2', 'ReAct', '2026-09-17T04:42:29Z'),
  ];
  const result = await trackNewPapers(papers, store, NOW);
  assert.deepEqual(result, { count: 1, titles: ['OpenHands'] });
  assert.equal((await store.list('paper', '1970-01-01T00:00:00.000Z')).length, 3, 'all three are now known');
});

test('later runs: a paper the assistant has not seen before is new, and one it has seen is not', async () => {
  const store = createMemoryStore(() => NOW);
  const first = [paper('a', '기존', '2026-09-01T00:00:00Z')];
  await trackNewPapers(first, store, new Date('2026-10-01T00:00:00Z'));

  const next = await trackNewPapers([...first, paper('b', '새 논문', '2026-10-04T00:00:00Z')], store, NOW);
  assert.deepEqual(next, { count: 1, titles: ['새 논문'] });

  const again = await trackNewPapers([...first, paper('b', '새 논문', '2026-10-04T00:00:00Z')], store, NOW);
  assert.equal(again.count, 1, 'still within the week, counted from the first time it was seen');
  assert.equal((await store.list('paper', '1970-01-01T00:00:00.000Z')).length, 2, 'not recorded twice');
});

test('a paper first seen more than a week ago stops being counted', async () => {
  const store = createMemoryStore(() => NOW);
  await trackNewPapers([paper('a', '기존', '2026-09-01T00:00:00Z')], store, new Date('2026-09-20T00:00:00Z'));
  await trackNewPapers([paper('a', '기존', '2026-09-01T00:00:00Z'), paper('b', '9월 말 논문', '2026-09-25T00:00:00Z')], store, new Date('2026-09-25T00:00:00Z'));
  const week = await trackNewPapers([paper('a', '기존', '2026-09-01T00:00:00Z'), paper('b', '9월 말 논문', '2026-09-25T00:00:00Z')], store, NOW);
  assert.equal(week.count, 0);
});

test('titles are the newest first and limited to three', async () => {
  const store = createMemoryStore(() => NOW);
  await trackNewPapers([paper('z', '기준', '2026-08-01T00:00:00Z')], store, new Date('2026-09-01T00:00:00Z'));
  const papers = ['a', 'b', 'c', 'd', 'e'].map((k, i) => paper(k, `논문 ${k}`, `2026-10-0${i + 1}T00:00:00Z`));
  const result = await trackNewPapers([paper('z', '기준', '2026-08-01T00:00:00Z'), ...papers], store, NOW);
  assert.equal(result.count, 5);
  assert.equal(result.titles.length, 3);
});

test('a dry run computes the same answer but records nothing', async () => {
  const store = createMemoryStore(() => NOW);
  const result = await trackNewPapers([paper('new', 'OpenHands', '2026-10-04T11:21:33Z')], store, NOW, { dryRun: true });
  assert.deepEqual(result, { count: 1, titles: ['OpenHands'] });
  assert.equal((await store.list('paper', '1970-01-01T00:00:00.000Z')).length, 0);
});

test('no papers means no count', async () => {
  assert.deepEqual(await trackNewPapers([], createMemoryStore(() => NOW), NOW), { count: 0, titles: [] });
});
