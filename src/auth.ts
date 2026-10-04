import { timingSafeEqual } from 'node:crypto';

// "Authorization: Bearer <비밀값>" 헤더가 비밀값과 같은지 시간 일정 비교로 확인한다.
// 비밀값이 비어 있으면 어떤 요청도 통과시키지 않는다.
export function isBearerAuthorized(request: Request, secret: string): boolean {
  if (!secret) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
