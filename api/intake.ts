import { requireEnv } from '../src/config.ts';
import { handleIntake } from '../src/intake.ts';

export default {
  fetch(request: Request): Promise<Response> {
    const { INTAKE_SECRET } = requireEnv(process.env, ['INTAKE_SECRET']);
    return handleIntake(request, {
      secret: INTAKE_SECRET,
      // 해석 단계는 task 3.2에서 연결한다. 그 전에는 배포하지 않는다.
      interpret: async () => {
        throw new Error('interpretation is not implemented yet (task 3.2)');
      },
    });
  },
};
