import { isBearerAuthorized } from './auth.js';

export type IntakeDeps = {
  secret: string;
  // 입력이 잘못되면 { error }를 돌려주고, 그러면 400으로 응답한다.
  // dryRun이면 해석만 하고 아무것도 저장하지 않는다(?dry=1).
  interpret: (input: unknown, options: { dryRun: boolean }) => Promise<{ message: string } | { error: string }>;
};

// 인증이 통과하기 전에는 본문을 읽지도, 해석 단계를 부르지도 않는다.
export async function handleIntake(request: Request, deps: IntakeDeps): Promise<Response> {
  if (!isBearerAuthorized(request, deps.secret)) {
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

  const dryRun = new URL(request.url).searchParams.get('dry') === '1';
  const result = await deps.interpret(input, { dryRun });
  return 'error' in result
    ? Response.json(result, { status: 400 })
    : Response.json(result);
}
