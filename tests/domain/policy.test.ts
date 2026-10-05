import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTION_TIERS, buildToolset, type Proposal, type Tier } from '../../src/domain/policy.ts';

const noop = async () => ({ ok: true });
const namesOf = (tier: Tier) =>
  Object.entries(ACTION_TIERS)
    .filter(([, t]) => t === tier)
    .map(([name]) => name);

test('toolset never contains a forbidden action', () => {
  const toolset = buildToolset({ read_tasks: noop, create_task: noop }, async () => {});
  for (const name of namesOf('forbidden')) {
    assert.equal(name in toolset, false, `${name} must not be exposed`);
  }
});

test('free and notify implementations pass through unchanged', () => {
  const toolset = buildToolset({ read_tasks: noop, create_task: noop }, async () => {});
  assert.equal(toolset.read_tasks, noop);
  assert.equal(toolset.create_task, noop);
});

test('rejects implementations for forbidden, confirm, and unclassified actions', () => {
  const record = async () => {};
  assert.throws(() => buildToolset({ send_mail: noop }, record), /tier is forbidden/);
  assert.throws(() => buildToolset({ update_task: noop }, record), /tier is confirm/);
  assert.throws(() => buildToolset({ mystery_tool: noop }, record), /not classified/);
});

test('a confirm action records a proposal and performs no write', async () => {
  const proposals: Proposal[] = [];
  const toolset = buildToolset({ read_tasks: noop }, async (p) => {
    proposals.push(p);
  });

  const input = { id: 7, deadline: '2026-11-20' };
  const result = await toolset.update_task(input);

  assert.deepEqual(result, { status: 'proposed' });
  assert.deepEqual(proposals, [{ action: 'update_task', input }]);
});

test('docs/delegation.md lists exactly the actions in ACTION_TIERS, under the right tier', () => {
  const doc = readFileSync(new URL('../../docs/delegation.md', import.meta.url), 'utf8');
  const documented: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of doc.split('\n')) {
    const heading = line.match(/^## (free|notify|confirm|forbidden)\b/);
    if (heading) {
      current = heading[1];
      documented[current] = [];
      continue;
    }
    const item = line.match(/^- `([a-z_]+)`/);
    if (item && current) documented[current].push(item[1]);
  }

  for (const tier of ['free', 'notify', 'confirm', 'forbidden'] as const) {
    assert.deepEqual((documented[tier] ?? []).sort(), namesOf(tier).sort(), `tier ${tier}`);
  }
});
