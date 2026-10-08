# veloo-secretary

[English](README.md) | 한국어

말하거나, 사진을 찍거나, 메일로 받은 일정을 할 일 앱(벨루)의 태스크로 바꿔 넣고, 아침마다 카카오톡으로 브리핑해 주는 개인 비서입니다.

자율 에이전트가 아니라 비서입니다. 추가하고 알리는 데까지만 하고, 기존 일정을 고치거나 지우거나 대신 발송하는 일은 확인을 받은 뒤에만 합니다.

## 목차

- [동작 방식](#동작-방식)
- [기능](#기능)
- [브리핑 예시](#브리핑-예시)
- [시작하기](#시작하기)
- [사용법](#사용법)
- [프로젝트 구조](#프로젝트-구조)
- [스크립트와 테스트](#스크립트와-테스트)
- [안전과 한계](#안전과-한계)
- [문서](#문서)

## 동작 방식

```
아이폰 단축어 --POST--> /api/intake      해석 -> 벨루에 저장 -> 카톡으로 결과 알림
Gmail(읽기 전용) --+
Vercel Cron(매일) -+--> /api/cron/daily   메일 선별 -> 벨루에 반영 -> 아침 브리핑 -> 카톡
```

- **벨루**가 중심 장부입니다(제작자가 직접 만든 할 일 앱).
- **Gemini**가 텍스트와 이미지를 읽어 할 일과 마감을 뽑습니다.
- **Supabase**에 처리 이력과 토큰을 저장해서, 지운 태스크가 되살아나거나 같은 내용이 두 번 보고되지 않게 합니다.
- **카카오톡 나에게 보내기**는 출력 전용입니다.

## 기능

- **빠른 입력**: 아이폰 단축어로 글, 음성, 화면 캡처(카톡 대화 등), 손글씨 사진을 보냅니다.
- **PC 입력**: 브라우저에서 캡처 페이지(`https://cap.2joon.com`)를 열고 캡처를 `Ctrl+V`로 붙여넣거나 글 한 줄을 쓰고 Enter를 누릅니다. 설치가 필요 없습니다.
- **모델 라우팅**: 가벼운 모델이 모두 읽고, 이미지가 손글씨로 판단되면 큰 모델이 다시 읽습니다.
- **메일 선별**: Gmail을 키워드로 거른 뒤 모델이 중요도를 판단하고 마감을 뽑습니다.
- **아침 브리핑**: 오늘 먼저 할 일 Top 3(한 줄 이유 포함), 밀린 일, 임박, 방치된 태스크, 메일 마감, 폴리오 새 논문, 지난주 리뷰.
- **중복 방지**: 단축어 재시도나 같은 메일이 다시 와도 같은 태스크가 두 번 생기지 않습니다.
- **위임 정책**: 자유 / 알리고 수행 / 확인 후 / 금지 단계를, 코드가 노출하는 도구로 강제합니다.
- **시험 실행 모드**: 아무것도 쓰지 않고 결과만 봅니다.

## 브리핑 예시

```
10/8(목) 아침 보고 (1/2)

[먼저 할 일]
1) 보고서 제출 — 오늘 마감
2) 지도비 송금 — 2일 남음
3) 4장 읽기 — 방치

[오늘]
· 보고서 제출

(2/2)

[밀린 일]
· 책 주문(10/5, 3일째)

[임박]
· 지도비 송금(10/10·2일 후)

[지난주]
· 완료 6 · 생성 8 · 밀림 2
```

보고는 구역 단위로 나뉘고, 한 구역이 카톡 말풍선 사이에서 반으로 잘리지 않습니다. 길면 최대 3통(통당 200자)으로 이어서 보냅니다.

## 시작하기

준비물: Node 24, Vercel 계정, Supabase 프로젝트, Gemini API 키, 벨루 계정, 카카오 개발자 앱, Google OAuth 클라이언트(Gmail 읽기 전용).

1. 의존성을 설치합니다.
   ```
   npm install
   ```
2. 테이블을 만듭니다. Supabase SQL 편집기에서 `supabase/assistant.sql`을 한 번 실행합니다.
3. `.env.example`을 `.env.local`로 복사해 값을 채웁니다. 실제 값은 절대 커밋하지 않습니다.

   | 이름 | 용도 |
   |---|---|
   | `INTAKE_SECRET` | 단축어와 입력 페이지가 Bearer 토큰으로 보내는 공유 비밀값 |
   | `CRON_SECRET` | Cron 호출 인증(헤더는 Vercel이 붙임) |
   | `GEMINI_API_KEY`, `GEMINI_MODEL` | 텍스트와 일반 화면 캡처용 기본 모델 |
   | `GEMINI_HIGH_MODEL` | 선택. 손글씨를 다시 읽는 큰 모델 |
   | `VELOO_BASE_URL`, `VELOO_USERNAME`, `VELOO_PASSWORD` | 벨루 로그인(전용 계정 권장) |
   | `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | Gmail 읽기 전용 |
   | `MAIL_KEYWORDS`, `MAIL_LOOKBACK_DAYS` | 메일 선별 키워드(쉼표 구분)와 조회 기간(기본 2일) |
   | `KAKAO_REST_API_KEY`, `KAKAO_CLIENT_SECRET`, `KAKAO_REFRESH_TOKEN` | 카톡 나에게 보내기 |
   | `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` | 이력·토큰 저장소 |

4. Vercel에 배포하고 같은 환경 변수를 넣습니다(다음 배포부터 적용됩니다).
   ```
   vercel env add NAME production --sensitive
   vercel deploy --prod
   ```
5. 아이폰 단축어를 만듭니다. [docs/shortcut.md](docs/shortcut.md), [docs/shortcut-prompts.md](docs/shortcut-prompts.md)를 보세요.

브리핑 시각은 `vercel.json`의 `crons`로 정합니다(UTC 기준). 무료(Hobby) 플랜은 하루 한 번이며 몇 분 늦게 시작할 수 있습니다.

## 사용법

`Authorization: Bearer <INTAKE_SECRET>`와 함께 `POST /api/intake`를 호출합니다. 쿼리 파라미터:

| 파라미터 | 효과 |
|---|---|
| `async=1` | 바로 202로 응답하고, 끝나면 결과를 카톡으로 보냄 |
| `format=text` | 단축어에 그대로 보여 줄 수 있는 평문 응답 |
| `dry=1` | 해석만 하고 아무것도 쓰지 않음 |
| `quality=high` | 큰 모델을 강제로 사용 |

실제로 쓰는 단축어 주소는 `/api/intake?async=1&format=text`입니다.

`GET /api/cron/daily`(Bearer `CRON_SECRET`)가 브리핑을 실행합니다. `?dry=1`을 붙이면 카톡 발송과 모든 쓰기 없이 보고 내용만 돌려줍니다. 다만 메일 내용은 실제로 Gemini에 전송됩니다.

## 프로젝트 구조

```
src/
  adapters/  외부 서비스 하나당 파일 하나: gemini gmail kakao veloo folio store
  domain/    순수한 규칙과 계산: interpret ledger brief report mail policy papers
  flows/     규칙을 이어 한 번의 일을 처리: daily, intake-flow
  http/      요청 처리와 인증
  config.ts  환경 변수 검사
  wire.ts    모든 것을 실제 서비스에 연결하는 유일한 곳
api/         Vercel Functions 진입점
public/      브라우저 입력 페이지(index.html)와 순수 로직(capture-lib.js)
tests/       모든 테스트(src와 같은 폴더 구조, 브라우저 스크립트 테스트는 tests/public/)
scripts/     실제 서비스를 부르는 개발 도구
supabase/    assistant.sql
openspec/    스펙, 설계, 작업 목록
```

의존은 한 방향으로만 흐릅니다. 계층이 가져오면 안 되는 것을 가져오거나, `.js` 대신 `.ts`로 가져오거나, `src/` 안에 테스트를 두거나, 소스에 짝이 되는 테스트가 없으면 `tests/structure.test.ts`가 실패합니다. 기여자와 AI 에이전트용 규칙은 [AGENTS.md](AGENTS.md)에 있습니다.

## 스크립트와 테스트

```
npm test                # 단위 테스트(네트워크 없음)
npm run typecheck       # 타입 검사만
npm run test:live       # 실제 모델로 해석 시험
npm run gmail:check     # Gmail 읽기 가능, 쓰기는 거부(403) 확인
npm run mail:dryrun     # 실제 메일을 선별하되 아무것도 쓰지 않음
npm run store:check     # Supabase 저장소 시험
npm run model:compare   # 손글씨 사진으로 모델 비교
npm run assistant:tasks # 비서가 만든 태스크 목록
```

실제 서비스를 쓰는 스크립트는 `.env.local`을 읽습니다.

## 안전과 한계

- Gmail 권한은 `gmail.readonly`입니다. 코드에 발송·삭제 경로가 없습니다.
- 벨루 클라이언트는 목록 조회와 생성만 합니다. 수정·삭제는 일부러 넣지 않았습니다.
- 메일과 입력 내용은 Gemini API로 전송됩니다.
- 서버가 쓰는 키는 해당 Supabase 프로젝트의 관리자 키입니다. 비서 전용 프로젝트를 쓰세요.
- 카톡방 대화 읽기는 범위 밖입니다(공식 API 없음). 대신 화면 캡처를 보내세요.
- Vercel Hobby의 로그는 약 1시간만 남으므로, 예약 실행은 저장소의 `last_report_at`으로 확인합니다.

## 문서

- [docs/operations.md](docs/operations.md) 운영 방법, 환경 변수, 브리핑 구성
- [docs/delegation.md](docs/delegation.md) 위임 단계
- [docs/mail-keywords.md](docs/mail-keywords.md) 메일 키워드
- [docs/shortcut.md](docs/shortcut.md), [docs/shortcut-prompts.md](docs/shortcut-prompts.md) 아이폰 단축어 설정
- [docs/desktop-capture.md](docs/desktop-capture.md) PC 브라우저에서 캡처나 글 한 줄로 입력하기
- [openspec/changes/personal-secretary/](openspec/changes/personal-secretary/) 제안, 설계, 스펙, 작업 목록

라이선스는 아직 정하지 않았습니다.
