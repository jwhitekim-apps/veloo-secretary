export class ConfigError extends Error {}

type Env = Record<string, string | undefined>;

// 필요한 환경 변수를 한 번에 확인한다. 비어 있는 항목은 모두 모아서 함께 알린다.
export function requireEnv<K extends string>(env: Env, keys: readonly K[]): Record<K, string> {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length > 0) {
    throw new ConfigError(`Missing environment variables: ${missing.join(', ')}`);
  }
  return Object.fromEntries(keys.map((key) => [key, env[key] as string])) as Record<K, string>;
}
