# veloo-secretary

English | [한국어](README_KO.md)

A personal secretary that turns what you say, photograph, or receive by email into tasks in your todo app, then sends you a morning briefing on KakaoTalk.

It is a secretary, not an autonomous agent: it adds and reports, and anything that edits, deletes, or sends on your behalf waits for your confirmation.

## Contents

- [How it works](#how-it-works)
- [Features](#features)
- [Sample briefing](#sample-briefing)
- [Getting started](#getting-started)
- [Usage](#usage)
- [Project structure](#project-structure)
- [Scripts and tests](#scripts-and-tests)
- [Safety and limits](#safety-and-limits)
- [Docs](#docs)

## How it works

```
iPhone Shortcuts --POST--> /api/intake     interpret -> write to Veloo -> reply on Kakao
Gmail (read-only) --+
Vercel Cron (daily) +----> /api/cron/daily  triage mail -> sync to Veloo -> morning briefing -> Kakao
```

- **Veloo** is the central ledger (the author's own todo app).
- **Gemini** reads text and images and extracts tasks and deadlines.
- **Supabase** stores processing history and tokens, so deleted tasks are not resurrected and nothing is reported twice.
- **KakaoTalk "send to me"** is output only.

## Features

- **Quick capture** from iPhone Shortcuts: typed text, voice, screenshots (for example a chat), and photos of handwriting.
- **Desktop capture**: open `/capture.html` in any browser, paste a screenshot with `Ctrl+V` or type a line and press Enter. No install.
- **Model routing**: a light model reads everything; if the image is handwriting, a larger model re-reads it.
- **Mail triage**: keyword filter on Gmail, then the model judges importance and extracts deadlines.
- **Morning briefing**: top 3 things to do first with a short reason, overdue, due soon, stale tasks, mail deadlines, new papers from Folio, last week's review.
- **No duplicates**: retries and re-sent mail do not create the same task twice.
- **Delegation policy** enforced by which tools the code exposes (free / notify / confirm / forbidden).
- **Dry-run modes** that write nothing.

## Sample briefing

```
10/5(Mon) morning report
First: 1) Submit report - due today  2) Pay advisor fee - 2 days left  3) Read ch.4 - stale
Today: Submit report
Overdue: Book order (3 days)
Due soon: Pay advisor fee (2 days)
Mail deadline: Scholarship form 10/9
Folio: 2 new papers this week
Last week: done 6 / created 8 / overdue 2
```

Long reports continue across up to three Kakao messages (200 characters each).

## Getting started

Requirements: Node 24, a Vercel account, a Supabase project, a Gemini API key, a Veloo account, a Kakao developers app, and a Google OAuth client (Gmail read-only).

1. Install dependencies.
   ```
   npm install
   ```
2. Create the tables: run `supabase/assistant.sql` once in the Supabase SQL editor.
3. Copy `.env.example` to `.env.local` and fill in the values. Never commit real values.

   | Name | Purpose |
   |---|---|
   | `INTAKE_SECRET` | Shared secret the Shortcut and the capture page send as a Bearer token |
   | `CRON_SECRET` | Authenticates the Cron call (Vercel adds the header) |
   | `GEMINI_API_KEY`, `GEMINI_MODEL` | Base model for text and general screenshots |
   | `GEMINI_HIGH_MODEL` | Optional larger model used to re-read handwriting |
   | `VELOO_BASE_URL`, `VELOO_USERNAME`, `VELOO_PASSWORD` | Veloo login (a dedicated account is recommended) |
   | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Gmail read-only access |
   | `MAIL_KEYWORDS`, `MAIL_LOOKBACK_DAYS` | Mail filter (comma separated) and lookback days (default 2) |
   | `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, `KAKAO_REFRESH_TOKEN` | Kakao "send to me" |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | History and token store |

4. Deploy to Vercel and add the same variables there (they apply from the next deploy).
   ```
   vercel env add NAME production --sensitive
   vercel deploy --prod
   ```
5. Set up the iPhone Shortcut: see [docs/shortcut.md](docs/shortcut.md) and [docs/shortcut-prompts.md](docs/shortcut-prompts.md).

The briefing time is set by `crons` in `vercel.json` (UTC; the Hobby plan runs once a day and may start several minutes late).

## Usage

Send `POST /api/intake` with `Authorization: Bearer <INTAKE_SECRET>`. Query parameters:

| Parameter | Effect |
|---|---|
| `async=1` | Reply 202 at once and send the result on Kakao when done |
| `format=text` | Plain-text reply, for showing in a Shortcut |
| `dry=1` | Interpret only; write nothing |
| `quality=high` | Force the larger model |

The Shortcut URL used in practice is `/api/intake?async=1&format=text`.

`GET /api/cron/daily` (Bearer `CRON_SECRET`) runs the briefing. Add `?dry=1` to see the report without sending Kakao or writing anything. Mail content is still sent to Gemini.

## Project structure

```
src/
  adapters/  one external service per file: gemini gmail kakao veloo folio store
  domain/    pure rules and calculations: interpret ledger brief report mail policy papers
  flows/     chains rules into one job: daily, intake-flow
  http/      request handling and auth
  config.ts  env checks
  wire.ts    the only place that connects everything to real services
api/         Vercel Functions entry points
public/      browser capture page (capture.html) and its pure logic (capture-lib.js)
tests/       all tests, mirroring the src/ layout (browser script tests in tests/public/)
scripts/     dev tools that call real services
supabase/    assistant.sql
openspec/    specs, design, tasks
```

Dependencies point one way. `tests/structure.test.ts` fails if a layer imports something it should not, if an import uses `.ts` instead of `.js`, if a test sits inside `src/`, or if a source file has no matching test. See [AGENTS.md](AGENTS.md) for contributor and agent rules.

## Scripts and tests

```
npm test                # unit tests, no network
npm run typecheck       # type-check only
npm run test:live       # interpret against the real model
npm run gmail:check     # Gmail read works, writes are rejected (403)
npm run mail:dryrun     # triage real mail, write nothing
npm run store:check     # exercise the Supabase store
npm run model:compare   # compare models on handwriting photos
npm run assistant:tasks # list tasks the assistant created
```

Scripts that touch real services read `.env.local`.

## Safety and limits

- Gmail scope is `gmail.readonly`; the code has no send or delete path.
- The Veloo client can list and create tasks only. There is no update or delete, by design.
- Mail and input text are sent to the Gemini API.
- The service key in use is an admin key for that Supabase project; use a project dedicated to the secretary.
- Reading KakaoTalk chats is out of scope (no official API); share a screenshot instead.
- Logs on Vercel Hobby are kept for about an hour, so check scheduled runs through `last_report_at` in the store.

## Docs

Written in Korean:

- [docs/operations.md](docs/operations.md) operations, env vars, briefing sections
- [docs/delegation.md](docs/delegation.md) delegation tiers
- [docs/mail-keywords.md](docs/mail-keywords.md) mail keywords
- [docs/shortcut.md](docs/shortcut.md), [docs/shortcut-prompts.md](docs/shortcut-prompts.md) iPhone Shortcut setup
- [docs/desktop-capture.md](docs/desktop-capture.md) capture from a PC browser (paste a screenshot or a line)
- [openspec/changes/personal-secretary/](openspec/changes/personal-secretary/) proposal, design, specs, tasks

No license has been chosen yet.
