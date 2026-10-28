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

## Getting started

Use an existing Vercel deployment configured for Gemini, Veloo, and Kakao, with its `INTAKE_SECRET` ready.

1. Open the deployment's root URL, as described in the [browser capture guide](docs/desktop-capture.md).
2. Type a task and press `Enter`. Enter `INTAKE_SECRET` when prompted.
3. Read the result in KakaoTalk “send to me” and check the task in Veloo.

## Documentation (Korean)

- [Configuration and operations](docs/operations.md)
- [iPhone Shortcuts](docs/shortcut.md)
- [Browser capture](docs/desktop-capture.md)
- [Mail keywords](docs/mail-keywords.md)
- [Delegation policy](docs/delegation.md)
- [Behavior specs](openspec/specs/)

Architecture and development rules are in [AGENTS.md](AGENTS.md).

## License

No LICENSE file; license terms need confirmation.
