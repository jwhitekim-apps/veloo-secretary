// 아침 브리핑의 "무엇을 먼저 할까" 판단. 계산은 모두 순수 함수이고, 모델은 후보 가운데서 고르고 이유를 쓰는 데만 쓴다.
export type BriefTask = {
  id: number;
  name: string;
  memo: string;
  priority: string;
  deadline: string;
  done: boolean;
  created_at?: string;
};

export type Ranked = { id: number; name: string; priority: string; deadline: string; score: number; reason: string };
export type Pick = { name: string; reason: string };

const DEFAULT_TIME_ZONE = 'Asia/Seoul';
export const STALE_DAYS = 14;
const isYmd = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

// 두 날짜(YYYY-MM-DD)의 차이(b - a)를 일 단위로 구한다.
export function daysBetween(a: string, b: string): number {
  const ms = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

function localYmd(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

function ageDays(task: BriefTask, today: string, timeZone: string): number {
  if (!task.created_at) return 0;
  const created = localYmd(task.created_at, timeZone);
  return Math.max(0, daysBetween(created, today));
}

// 마감·우선순위·오래된 정도로 점수를 매기고, 사람이 읽을 이유를 규칙으로 만든다. 높은 점수가 먼저다.
export function rankTasks(tasks: BriefTask[], today: string, timeZone = DEFAULT_TIME_ZONE): Ranked[] {
  const ranked: Ranked[] = [];
  for (const t of tasks) {
    if (t.done) continue;
    const age = ageDays(t, today, timeZone);
    const parts: string[] = [];
    let score = 0;

    if (t.priority === 'urgent') {
      score += 3;
      parts.push('급함');
    } else if (t.priority === 'mid') {
      score += 1.5;
      parts.push('중요');
    }

    if (isYmd(t.deadline)) {
      const left = daysBetween(today, t.deadline);
      if (left < 0) {
        // 이미 늦은 일은 오늘 마감인 일(5점)보다 항상 앞선다.
        score += 5 + Math.min(-left, 30) / 10;
        parts.push(`${-left}일 밀림`);
      } else if (left === 0) {
        score += 5;
        parts.push('오늘 마감');
      } else if (left <= 3) {
        score += 3.5 - (left - 1) * 0.5;
        parts.push(`${left}일 남음`);
      } else if (left <= 7) {
        score += 1.5;
        parts.push(`${left}일 남음`);
      } else {
        score += 0.5;
        parts.push(`${left}일 남음`);
      }
    } else if (age >= STALE_DAYS) {
      parts.push(`${age}일째 방치`);
    }
    score += (Math.min(age, 30) / 30) * 1.5;

    ranked.push({ id: t.id, name: t.name, priority: t.priority, deadline: t.deadline, score, reason: parts.join(' · ') || '마감 없음' });
  }
  return ranked.sort((a, b) => b.score - a.score || a.id - b.id);
}

// 마감이 없고 오래 손대지 않은 일.
export function staleTasks(tasks: BriefTask[], today: string, timeZone = DEFAULT_TIME_ZONE, minDays = STALE_DAYS) {
  return tasks
    .filter((t) => !t.done && !isYmd(t.deadline))
    .map((t) => ({ name: t.name, days: ageDays(t, today, timeZone) }))
    .filter((t) => t.days >= minDays)
    .sort((a, b) => b.days - a.days);
}

// 메일에서 가져온 태스크 중 마감이 지나지 않은 것을 마감이 가까운 순으로.
// 메일에서 만든 태스크는 처리 기록의 번호(mailTaskIds)로 알아보고, 예전 표식(`[비서:mail:…]`)이 있는 것도 인정한다.
export function mailDeadlines(tasks: BriefTask[], today: string, mailTaskIds: ReadonlySet<number> = new Set()) {
  return tasks
    .filter(
      (t) =>
        !t.done &&
        (mailTaskIds.has(t.id) || t.memo.includes('[비서:mail:')) &&
        isYmd(t.deadline) &&
        t.deadline >= today,
    )
    .map((t) => ({ name: t.name, deadline: t.deadline, daysLeft: daysBetween(today, t.deadline) }))
    .sort((a, b) => a.deadline.localeCompare(b.deadline));
}

// 지난주(월~일)의 시작: 오늘이 속한 주의 월요일에서 7일 전, 한국 시간 00:00의 ISO 시각.
export function lastWeekStart(today: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d));
  const sinceMonday = (day.getUTCDay() + 6) % 7; // 월=0 … 일=6
  const monday = new Date(Date.UTC(y, m - 1, d - sinceMonday - 7));
  return `${monday.toISOString().slice(0, 10)}T00:00:00+09:00`;
}

const CANDIDATES = 6;
const TOP = 3;
const REASON_LIMIT = 30;

const PICK_SCHEMA = {
  type: 'object',
  properties: {
    picks: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'number' }, reason: { type: 'string' } },
        required: ['id', 'reason'],
      },
    },
  },
  required: ['picks'],
};

function pickPrompt(candidates: Ranked[], today: string): string {
  const list = candidates
    .map((c) => `- id ${c.id}: ${c.name} | 우선순위 ${c.priority} | 마감 ${c.deadline || '없음'} | 규칙 점수 이유: ${c.reason}`)
    .join('\n');
  return [
    `오늘은 ${today}이다. 너는 개인 비서다. 아래 후보 중에서 사용자가 오늘 가장 먼저 해야 할 일 ${TOP}개를 순서대로 골라라.`,
    '- 마감이 가까운 일, 급한 일, 밀린 일을 우선하되, 돈이나 제출처럼 놓치면 곤란한 일을 더 앞에 둘 수 있다.',
    `- 각 항목에 이유를 ${REASON_LIMIT}자 이내의 **짧은 명사형 어구**로 써라. 예: "오늘 마감", "송금 · 4일 남음", "급함 · 35일째 밀림".`,
    '- "~기 때문", "~입니다" 같은 문장형으로 쓰지 말고, 날짜(2026-10-05)를 그대로 옮기지 마라. 몇 일 남았는지나 밀렸는지로 말하라.',
    '- 후보에 적힌 사실(마감, 우선순위, 밀린 일수)만 쓰고 지어내지 마라.',
    '- 후보에 없는 id를 쓰지 마라.',
    '',
    list,
  ].join('\n');
}

type GenerateJson = (request: { prompt: string; schema: object }) => Promise<unknown>;

// 후보(규칙 점수 상위 6개)에서 모델이 3개를 고르고 이유를 쓴다.
// 모델이 없거나, 실패하거나, 형식이 틀리거나, 후보에 없는 번호를 고르면 규칙 순위와 규칙 이유로 대신한다.
export async function pickTopTasks(ranked: Ranked[], today: string, generateJson?: GenerateJson): Promise<Pick[]> {
  const rule = (list: Ranked[]) => list.slice(0, TOP).map((r) => ({ name: r.name, reason: r.reason }));
  const candidates = ranked.slice(0, CANDIDATES);
  if (!generateJson || candidates.length <= 1) return rule(candidates);

  try {
    const raw = (await generateJson({ prompt: pickPrompt(candidates, today), schema: PICK_SCHEMA })) as { picks?: unknown } | null;
    if (!raw || !Array.isArray(raw.picks)) return rule(candidates);

    const byId = new Map(candidates.map((c) => [c.id, c]));
    const chosen: Pick[] = [];
    const used = new Set<number>();
    for (const p of raw.picks as { id?: unknown; reason?: unknown }[]) {
      const c = typeof p?.id === 'number' ? byId.get(p.id) : undefined;
      if (!c || used.has(c.id)) continue;
      used.add(c.id);
      const reason = typeof p.reason === 'string' ? p.reason.trim() : '';
      chosen.push({ name: c.name, reason: (reason || c.reason).slice(0, REASON_LIMIT) });
      if (chosen.length === TOP) break;
    }
    // 모델이 3개를 못 채우면 규칙 순위로 이어서 채운다.
    for (const c of candidates) {
      if (chosen.length >= TOP) break;
      if (!used.has(c.id)) {
        used.add(c.id);
        chosen.push({ name: c.name, reason: c.reason });
      }
    }
    return chosen.length ? chosen : rule(candidates);
  } catch {
    return rule(candidates);
  }
}
