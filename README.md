# veloo-secretary

A self-hosted personal secretary. It turns text, screenshots, photos, and selected Gmail messages into tasks in **Veloo** (the author's todo app), then sends you a morning briefing on KakaoTalk.

```text
10/30(금) 아침 보고

[먼저 할 일]
1) 학회 초록 제출 — 마감 이틀 남음
2) 랩미팅 자료 — 오늘 15:00 발표

[오늘]
· 랩미팅 15:00

[밀린 일]
· 장비 반납(10/27, 3일째)

[임박]
· 학회 초록 제출(11/1·2일 후)

[추가]
· 세미나 등록(11/5)
```

<sub>Output of the briefing formatter (`buildReport` in `src/domain/report.ts`) on sample tasks.</sub>

## Features

- **Quick capture** — send text or images from iPhone Shortcuts, or paste into the browser capture page
- **Task extraction** — Gemini pulls out tasks and deadlines; unclear deadlines stay empty
- **Mail triage** — filter Gmail by keyword, judge importance, extract tasks
- **Morning briefing** — priorities, overdue and upcoming tasks, failures, and a weekly review
- **History** — Supabase records processed sources to reduce duplicates and avoid reprocessing mail

It only creates tasks. You edit or delete existing tasks in Veloo yourself. It cannot send email or make payments.

## Getting started

You need Node.js 24, the Vercel CLI and an account, a reachable Veloo server, a Gemini API key, a Supabase project, Gmail read-only OAuth credentials, and Kakao "send to me" credentials.

1. Install and copy the config:

   ```sh
   npm install
   cp .env.example .env.local
   ```

2. Run [`supabase/assistant.sql`](supabase/assistant.sql) once in the Supabase SQL editor. Use a dedicated project — the server uses an admin key.
3. Fill in `.env.local` using the [variable reference](docs/operations.md).
4. Add the same variables to Vercel and deploy:

   ```sh
   vercel env add NAME production --sensitive   # once per variable
   vercel deploy --prod
   ```

5. Check `/api/hello`, then set up [iPhone Shortcuts](docs/shortcut.md) or the [browser capture page](docs/desktop-capture.md).

The daily schedule (UTC) is in [`vercel.json`](vercel.json).

To preview a briefing, call `GET /api/cron/daily?dry=1` with `Authorization: Bearer <CRON_SECRET>`. It still calls Gemini. On intake, `dry=1` skips task creation, but **`dry=1&async=1` still sends a Kakao notification**.

## Documentation (Korean)

- [Operations](docs/operations.md) · [Mail keywords](docs/mail-keywords.md) · [Delegation policy](docs/delegation.md)
- [iPhone Shortcut](docs/shortcut.md) · [Browser capture](docs/desktop-capture.md)
- [Behavior specs](openspec/specs/)

## Development

```sh
npm test
npm run typecheck
```

Architecture and contribution rules are in [AGENTS.md](AGENTS.md).

## License

No LICENSE file; license terms need confirmation.
