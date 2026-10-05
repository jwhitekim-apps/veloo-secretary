// Gmail 읽기 전용 클라이언트. 쓰기·발송 메서드는 일부러 만들지 않았고, 권한(gmail.readonly)도 읽기뿐이다.
export type MailMeta = { id: string; subject: string; from: string; date: string; snippet: string };

type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[] };

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const BODY_LIMIT = 6000;

function decode(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function collect(part: Part, mimeType: string, out: string[]): void {
  if (part.mimeType === mimeType && part.body?.data) out.push(decode(part.body.data));
  for (const child of part.parts ?? []) collect(child, mimeType, out);
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractText(payload: Part): string {
  const plain: string[] = [];
  collect(payload, 'text/plain', plain);
  if (plain.length) return plain.join('\n').trim();
  const html: string[] = [];
  collect(payload, 'text/html', html);
  return stripHtml(html.join('\n'));
}

export function createGmail(config: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetch?: typeof fetch;
  now?: () => Date;
}) {
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? (() => new Date());
  let access: { token: string; expiresAt: number } | null = null;

  async function refresh(): Promise<string> {
    const res = await doFetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: config.refreshToken,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Gmail token refresh failed -> ${res.status} ${body.error ?? ''}`.trim());
    }
    access = { token: body.access_token, expiresAt: now().getTime() + (body.expires_in ?? 3600) * 1000 };
    return access.token;
  }

  async function token(): Promise<string> {
    return access && access.expiresAt - 60_000 > now().getTime() ? access.token : refresh();
  }

  async function get(path: string): Promise<unknown> {
    const send = (t: string) => doFetch(`${API}${path}`, { headers: { authorization: `Bearer ${t}` } });
    let res = await send(await token());
    if (res.status === 401) res = await send(await refresh());
    if (!res.ok) throw new Error(`Gmail request failed: GET ${path.split('?')[0]} -> ${res.status}`);
    return res.json();
  }

  return {
    async search(query: string, max = 25): Promise<MailMeta[]> {
      const list = (await get(`/messages?q=${encodeURIComponent(query)}&maxResults=${max}`)) as { messages?: { id: string }[] };
      const metas: MailMeta[] = [];
      for (const { id } of list.messages ?? []) {
        const m = (await get(
          `/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        )) as { snippet?: string; payload?: { headers?: { name: string; value: string }[] } };
        const header = (name: string) =>
          m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';
        metas.push({ id, subject: header('Subject'), from: header('From'), date: header('Date'), snippet: m.snippet ?? '' });
      }
      return metas;
    },
    async readBody(id: string): Promise<string> {
      const m = (await get(`/messages/${id}?format=full`)) as { payload?: Part };
      return extractText(m.payload ?? {}).slice(0, BODY_LIMIT);
    },
  };
}
