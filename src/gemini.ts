import { GoogleGenAI } from '@google/genai';

type Request = {
  prompt: string;
  schema: object;
  image?: { data: string; mimeType: string };
};

// 모델 호출은 이 한 곳에서만 한다(design.md 결정 9).
export function createGenerateJson(config: { apiKey: string; model: string }) {
  const client = new GoogleGenAI({ apiKey: config.apiKey });

  return async ({ prompt, schema, image }: Request): Promise<unknown> => {
    const input: object[] = [{ type: 'text', text: prompt }];
    if (image) input.push({ type: 'image', data: image.data, mime_type: image.mimeType });

    const interaction = await client.interactions.create({
      model: config.model,
      input,
      response_format: { type: 'text', mime_type: 'application/json', schema },
    } as never);

    return JSON.parse(interaction.output_text as string);
  };
}
