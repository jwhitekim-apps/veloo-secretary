// src의 폴더 구조가 지키려는 규칙을 검사한다. 테스트는 모두 tests/에 모으고, src와 같은 폴더 구조를 따른다. 규칙이 깨지면 구조가 다시 흐트러지고 있다는 신호다.
//
//   http      요청 처리와 인증        → http만 안다
//   domain    순수한 규칙과 계산       → domain만 안다 (네트워크, 외부 서비스를 모른다)
//   adapters  외부 서비스와 통신       → 실행 시점에는 adapters만 안다(타입은 domain에서 가져올 수 있다)
//   flows     규칙을 이어 한 번의 일    → 실행 시점에는 domain/flows만 안다(타입은 adapters에서도 가져올 수 있다)
//   config, wire  조립               → wire만 모든 계층을 안다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const TESTS = join(ROOT, 'tests');

type Layer = 'http' | 'domain' | 'adapters' | 'flows' | 'root';
type Edge = { from: string; to: string; spec: string; typeOnly: boolean };

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const layerOf = (file: string): Layer => {
  const first = relative(SRC, file).split('/')[0];
  return ['http', 'domain', 'adapters', 'flows'].includes(first) ? (first as Layer) : 'root';
};

// 소스 파일(테스트 제외)이 가져오는 상대 경로를 모은다.
function edges(): Edge[] {
  const result: Edge[] = [];
  for (const file of walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^(import|export)\s+(type\s+)?[^;]*?from\s+'(\.[^']+)'/gms)) {
      const target = resolve(dirname(file), m[3].replace(/\.(js|ts)$/, ''));
      result.push({ from: relative(SRC, file), to: relative(SRC, target), spec: m[3], typeOnly: Boolean(m[2]) });
    }
  }
  return result;
}

const ALLOWED: Record<Exclude<Layer, 'root'>, { runtime: Layer[]; types: Layer[] }> = {
  http: { runtime: ['http'], types: ['http'] },
  domain: { runtime: ['domain'], types: ['domain'] },
  adapters: { runtime: ['adapters'], types: ['adapters', 'domain'] },
  flows: { runtime: ['domain', 'flows'], types: ['domain', 'flows', 'adapters'] },
};

const all = edges();

test('the layer folders exist and every source file sits in one of them (except config and wire)', () => {
  const rootFiles = readdirSync(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.deepEqual(rootFiles.sort(), ['config.ts', 'wire.ts']);
  for (const layer of ['http', 'domain', 'adapters', 'flows']) {
    assert.ok(statSync(join(SRC, layer)).isDirectory(), `${layer}/ is missing`);
  }
});

test('each layer only imports from the layers it is allowed to know', () => {
  const violations = all
    .filter((e) => layerOf(join(SRC, e.from)) !== 'root')
    .filter((e) => {
      const from = layerOf(join(SRC, e.from)) as Exclude<Layer, 'root'>;
      const to = layerOf(join(SRC, e.to));
      const allowed = e.typeOnly ? ALLOWED[from].types : ALLOWED[from].runtime;
      return !allowed.includes(to);
    })
    .map((e) => `${e.from} -> ${e.to}${e.typeOnly ? ' (type)' : ''}`);
  assert.deepEqual(violations, []);
});

test('config is a leaf: it imports nothing from src', () => {
  assert.deepEqual(all.filter((e) => e.from === 'config.ts'), []);
});

test('source files import siblings with ".js", because the deployed build compiles to .js and ".ts" paths break at runtime', () => {
  const wrong = all.filter((e) => e.spec.endsWith('.ts')).map((e) => `${e.from} imports ${e.spec}`);
  assert.deepEqual(wrong, []);
});

test('every relative import points at a file that exists', () => {
  const missing = all
    .filter((e) => {
      try {
        statSync(join(SRC, `${e.to}.ts`));
        return false;
      } catch {
        return true;
      }
    })
    .map((e) => `${e.from} -> ${e.to}`);
  assert.deepEqual(missing, []);
});

test('src holds no test files: every test lives under tests/', () => {
  assert.deepEqual(walk(SRC).filter((f) => f.endsWith('.test.ts')).map((f) => relative(SRC, f)), []);
});

test('every source file has a test at the same path under tests/, except the assembly file', () => {
  const sources = walk(SRC).filter((f) => f.endsWith('.ts') && !f.endsWith('wire.ts'));
  const untested = sources.filter((f) => !statSync(join(TESTS, relative(SRC, f)).replace(/\.ts$/, '.test.ts'), { throwIfNoEntry: false }));
  assert.deepEqual(untested.map((f) => relative(SRC, f)), []);
});

test('every test file under tests/ belongs to a source file (no orphans)', () => {
  const orphans = walk(TESTS)
    .filter((f) => f.endsWith('.test.ts') && !f.endsWith('structure.test.ts'))
    .filter((f) => !statSync(join(SRC, relative(TESTS, f)).replace(/\.test\.ts$/, '.ts'), { throwIfNoEntry: false }));
  assert.deepEqual(orphans.map((f) => relative(TESTS, f)), []);
});
