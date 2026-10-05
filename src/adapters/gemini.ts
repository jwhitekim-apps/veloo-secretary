import { GoogleGenAI } from '@google/genai';

type Request = {
  prompt: string;
  schema: object;
  image?: { data: string; mimeType: string };
  // 'high'면 읽기 어려운 입력(손글씨 사진 등)으로 보고 더 큰 모델(highModel)을 쓴다.
  quality?: 'high';
};

// 모델 고르기: 이미지이면서 high를 요청했고 highModel이 설정되어 있을 때만 큰 모델을 쓴다. 그 밖에는 모두 기본 모델이다.
export function pickModel(
  config: { model: string; highModel?: string },
  request: { hasImage: boolean; high: boolean },
): string {
  const high = config.highModel?.trim();
  return request.hasImage && request.high && high ? high : config.model;
}

// 앞의 모델이 실패하면(미리보기 모델이 사라지거나 응답 형식이 깨지는 경우 등) 다음 모델로 다시 시도한다.
export async function withFallback<T>(models: string[], call: (model: string) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const model of models) {
    try {
      return await call(model);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

// 모델 호출은 이 한 곳에서만 한다(design.md 결정 9).
export function createGenerateJson(config: { apiKey: string; model: string; highModel?: string }) {
  const client = new GoogleGenAI({ apiKey: config.apiKey });

  return async ({ prompt, schema, image, quality }: Request): Promise<unknown> => {
    const input: object[] = [{ type: 'text', text: prompt }];
    if (image) input.push({ type: 'image', data: image.data, mime_type: image.mimeType });

    const first = pickModel(config, { hasImage: Boolean(image), high: quality === 'high' });
    const models = first === config.model ? [first] : [first, config.model];

    return withFallback(models, async (model) => {
      const interaction = await client.interactions.create({
        model,
        input,
        response_format: { type: 'text', mime_type: 'application/json', schema },
      } as never);
      return JSON.parse(interaction.output_text as string);
    });
  };
}
