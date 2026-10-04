import { timingSafeEqual } from 'node:crypto';

export type IntakeDeps = {
  secret: string;
  interpret: (input: unknown) => Promise<{ message: string }>;
};

function isAuthorized(request: Request, secret: string): boolean {
  if (!secret) return false;
  const given = Buffer.from(request.headers.get('authorization') ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// 인증이 통과하기 전에는 본문을 읽지도, 해석 단계를 부르지도 않는다.
export async function handleIntake(request: Request, deps: IntakeDeps): Promise<Response> {
  if (!isAuthorized(request, deps.secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 });
  }

  return Response.json(await deps.interpret(input));
}
