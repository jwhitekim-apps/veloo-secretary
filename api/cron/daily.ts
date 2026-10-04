import { isBearerAuthorized } from '../../src/auth.js';
import { requireEnv } from '../../src/config.js';
import { createDailyRunner } from '../../src/wire.js';

// Vercel Cron은 CRON_SECRET 환경 변수가 있으면 "Authorization: Bearer <값>"을 붙여 호출한다.
// ?dry=1 이면 보고 내용만 만들어 돌려주고 카톡은 보내지 않는다(메일 선별과 벨루 쓰기는 평소처럼 실행된다).
export default {
  async fetch(request: Request): Promise<Response> {
    const { CRON_SECRET } = requireEnv(process.env, ['CRON_SECRET']);
    if (!isBearerAuthorized(request, CRON_SECRET)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const dryRun = new URL(request.url).searchParams.get('dry') === '1';
    const outcome = await createDailyRunner(process.env)({ dryRun });
    return Response.json(
      dryRun ? outcome : { sent: outcome.sent, failures: outcome.failures.length, messages: outcome.messages.length },
    );
  },
};
