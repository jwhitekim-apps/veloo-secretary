-- 비서(personal-secretary)가 쓰는 테이블. Supabase SQL 편집기에서 한 번 실행한다.
-- 벨루·폴리오 테이블과 이름이 겹치지 않도록 모두 assistant_ 접두사를 쓴다.
-- RLS를 켜고 정책을 만들지 않으므로, 서비스 키(서버)만 접근할 수 있다.

create table if not exists public.assistant_history (
  kind text not null,          -- 'mail' | 'intake' | 'proposal' | 'failure' | 'mail-seen'
  id   text not null,          -- 출처 식별자(메일 ID, 입력 요청 ID 등)
  at   timestamptz not null default now(),
  data jsonb not null default '{}'::jsonb,
  primary key (kind, id)
);

create index if not exists assistant_history_kind_at_idx on public.assistant_history (kind, at);

create table if not exists public.assistant_state (
  key        text primary key,  -- 예: 'kakao_refresh', 'last_report_at'
  value      text not null,
  updated_at timestamptz not null default now()
);

alter table public.assistant_history enable row level security;
alter table public.assistant_state  enable row level security;
