import { waitUntil } from '@vercel/functions';
import { requireEnv } from '../src/config.js';
import { handleIntake } from '../src/intake.js';
import { validateInput } from '../src/interpret.js';
import { createIntakeHandler, createIntakeNotifier } from '../src/wire.js';

export default {
  fetch(request: Request): Promise<Response> {
    const { INTAKE_SECRET } = requireEnv(process.env, ['INTAKE_SECRET']);
    return handleIntake(request, {
      secret: INTAKE_SECRET,
      // 나머지 설정은 인증이 통과한 뒤에 확인한다. 인증 없는 요청에는 설정 오류가 드러나지 않는다.
      interpret: (input, options) => createIntakeHandler(process.env)(input, options),
      validate: validateInput,
      runInBackground: waitUntil,
      notify: (text) => createIntakeNotifier(process.env)(text),
    });
  },
};
