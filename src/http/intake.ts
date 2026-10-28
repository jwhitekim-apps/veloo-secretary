import { isBearerAuthorized } from './auth.js';

export type IntakeDeps = {
  secret: string;
  // 입력이 잘못되면 { error }를 돌려주고, 그러면 400으로 응답한다.
  // dryRun이면 해석만 하고 아무것도 저장하지 않는다(?dry=1).
  interpret: (input: unknown, options: { dryRun: boolean; quality?: 'high' }) => Promise<{ message: string } | { error: string }>;
  // 아래 셋이 모두 있으면 ?async=1 요청을 즉시 접수하고, 처리는 뒤에서 이어서 한 뒤 결과를 알린다.
  // (Siri로 실행한 단축어는 응답을 오래 기다리면 실패하므로, 응답을 먼저 보내기 위한 것)
  validate?: (input: unknown) => string | null;
  runInBackground?: (task: Promise<unknown>) => void;
  notify?: (text: string) => Promise<void>;
};

type Payload = { message: string } | { error: string };

// 인증이 통과하기 전에는 본문을 읽지도, 해석 단계를 부르지도 않는다.
export async function handleIntake(request: Request, deps: IntakeDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  // ?format=text 이면 JSON 대신 문장만 돌려준다. 단축어(특히 Siri)가 사전 형태의 응답을 보여 주다 실패하는 경우를 피하기 위한 것이다.
  const asText = params.get('format') === 'text';
  const reply = (payload: Payload, status = 200): Response => {
    if (!asText) return Response.json(payload, { status });
    const text = 'message' in payload ? payload.message : `오류: ${payload.error}`;
    return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  };

  if (!isBearerAuthorized(request, deps.secret)) {
    return reply({ error: 'unauthorized' }, 401);
  }
  if (request.method !== 'POST') {
    return reply({ error: 'method not allowed' }, 405);
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return reply({ error: 'invalid json' }, 400);
  }

  const dryRun = params.get('dry') === '1';
  // ?quality=high: 손글씨 사진처럼 읽기 어려운 입력을 더 큰 모델로 처리한다. 다른 값은 무시한다.
  const options = { dryRun, quality: params.get('quality') === 'high' ? ('high' as const) : undefined };

  const { runInBackground, notify } = deps;
  if (!dryRun && params.get('async') === '1' && runInBackground && notify) {
    const invalid = deps.validate?.(input);
    if (invalid) return reply({ error: invalid }, 400);
    runInBackground(
      (async () => {
        let text: string;
        try {
          const outcome = await deps.interpret(input, options);
          text = 'error' in outcome ? `입력 오류: ${outcome.error}` : outcome.message;
        } catch (e) {
          text = `처리 실패: ${e instanceof Error ? e.message : String(e)}`;
        }
        // 알림마저 실패하면 보낼 곳이 없으므로 로그에만 남긴다.
        await notify(`[비서] ${text}`).catch((e) => console.error('intake notify failed:', e instanceof Error ? e.message : e));
      })(),
    );
    return reply({ message: '접수했어요. 결과는 카톡으로 보내 드릴게요.' }, 202);
  }

  const result = await deps.interpret(input, options);
  return 'error' in result ? reply(result, 400) : reply(result);
}
