import { isBearerAuthorized } from '../../src/http/auth.js';
import { requireEnv } from '../../src/config.js';
import { createDailyRunner } from '../../src/wire.js';

// Vercel Cron은 CRON_SECRET 환경 변수가 있으면 "Authorization: Bearer <값>"을 붙여 호출한다.
// ?dry=1 이면 메일을 선별해 추가 후보와 보고 내용만 돌려주고, 벨루·처리 이력·상태·카톡에는 아무것도 쓰지 않는다.
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
