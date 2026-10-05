# AGENTS.md

Guidance for AI coding agents (Claude Code, Codex, etc.) working in this repo.
Human-facing docs: `README.md` (English), `README_KO.md` (Korean), `docs/` (Korean).

## What this is

A personal secretary. Input arrives from iPhone Shortcuts (text / voice / screenshot / photo) and Gmail keyword triage. Tasks are written to Veloo (the owner's todo app, the central ledger). A morning briefing goes out through KakaoTalk "send to me". Specs live in `openspec/changes/personal-secretary/`.

## Commands

```
npm test                # node:test with a TS resolver (Node 24); no network
npm run typecheck       # tsc, type-check only (tsconfig.check.json)
npm run mail:dryrun     # real Gmail + Gemini, writes nothing
npm run assistant:tasks # list tasks the assistant created
```

Other `scripts/*` call real services and read `.env.local`. Do not run them unless asked. Run `npm test` and `npm run typecheck` before finishing any change; both must pass.

## Layout and import rules

```
src/
  adapters/  one external service per file (gemini gmail kakao veloo folio store)
  domain/    pure rules and calculations, no network (interpret ledger brief report mail policy papers)
  flows/     chain domain rules into one job (daily, intake-flow)
  http/      request handling and auth (intake, auth)
  config.ts  env checks (leaf, imports nothing from src)
  wire.ts    the only place that connects everything to real services
api/         Vercel Functions entry points (thin; call wire.ts)
scripts/     dev tools that hit real services
supabase/    assistant.sql
```

`src/structure.test.ts` enforces: `domain` imports only `domain`; `http` only `http`; `adapters` only `adapters` at runtime (types may come from `domain`); `flows` only `domain`/`flows` at runtime (types may also come from `adapters`); only `wire.ts` knows every layer. Source files import siblings with `.js` specifiers, never `.ts` (the deployed build breaks otherwise). Every source file except `wire.ts` has an adjacent `.test.ts`.

## Conventions

- Modules take their dependencies as arguments (fetch, store, clock, `generateJson`). Keep it that way so tests need no network.
- Code comments and user-facing strings are Korean. Match the surrounding style and density.
- Fail visibly: failures are recorded and shown in the briefing, never swallowed.
- Delegation policy (`src/domain/policy.ts`, `docs/delegation.md`): reading and drafting are free; adding tasks is notify; editing or deleting existing items and sending anything externally need confirmation; money and external submission are forbidden. The Veloo client has no update or delete by design. Do not add them.
- Gmail access is read-only (`gmail.readonly`). Do not widen the scope.
- `?dry=1` and `dryRun` must write nothing (Veloo, history, state, Kakao).
- Keep changes surgical. Mention unrelated problems instead of fixing them.

## Secrets

Never commit real values. `.env.example` lists names only; real values live in git-ignored `.env.local` and Vercel env vars. Do not print secrets in logs, docs, or test fixtures.

## Commits

English `type: what` messages (feat, fix, docs, refactor, test, chore, ...), at most 100 characters. One logical change per commit. Do not push unless the owner asks.

## Spec workflow

Behavior changes go through OpenSpec: update `openspec/changes/personal-secretary/{proposal,design,tasks}.md` and `specs/*/spec.md`, then run `openspec validate personal-secretary --strict`. Remaining tasks: 5.4, 6.4, 7.1.

## Do not touch without asking

The Veloo project lives outside this repo (`/Users/joon/CODINGPROJECT/veloo`). Confirm the exact file with the owner before editing anything there.
