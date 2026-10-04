import { readFileSync } from 'node:fs';

// 로컬 점검 스크립트용: 프로젝트 루트의 .env.local을 읽는다.
export function loadEnvLocal(): Record<string, string> {
  const env: Record<string, string> = {};
  const path = new URL('../.env.local', import.meta.url);
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
