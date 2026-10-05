// 비서가 태스크 메모에 붙였던 내부 표식(`[비서:mail:…#0]`)은 사용자에게 보여 주지 않는다.
// 지금은 새 태스크에 표식을 쓰지 않지만, 이미 벨루에 있는 태스크에는 남아 있을 수 있다.
export function stripMarker(memo: string): string {
  return memo.replace(/\[비서:[^\]]*\]/g, '').trim();
}

export type ReportInput = {
  now: Date;
  timeZone?: string;
  // 오늘 먼저 할 일 Top 3와 한 줄 이유
  top?: { name: string; reason: string }[];
  tasksToday: { name: string; memo: string }[];
  upcoming?: { name: string; deadline: string; daysLeft?: number }[];
  overdue?: { name: string; deadline: string; days?: number }[];
  undated?: { name: string; note: string }[];
  // 마감이 없는 채로 오래 손대지 않은 일
  stale?: { name: string; days: number }[];
  // 메일에서 가져온 일정 중 마감이 가까운 것
  mailDeadlines?: { name: string; deadline: string; daysLeft: number }[];
  // 지난주 완료·생성·밀린 일 통계(벨루 주간 리뷰)
  weekly?: { completed: number; created: number; overdue: number } | null;
  // 이번 주 폴리오에 새로 들어온 논문
  papers?: { count: number; titles: string[] } | null;
  created: { name: string; deadline: string }[];
  proposals: { name: string; currentDeadline: string; proposedDeadline: string }[];
  uncertain: string[];
  failures: string[];
  notes?: string[];
};

const DEFAULT_TIME_ZONE = 'Asia/Seoul';
const SECTION_CAP = 5;
const SMALL_CAP = 3;
const TITLE_LIMIT = 40;
export const UPCOMING_DAYS = 7;

const isYmd = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

function daysBetween(a: string, b: string): number {
  const ms = (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}

function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// 완료되지 않은 태스크를 마감 상태별로 나눈다. `YYYY-MM-DD`가 아닌 자유 문장 마감은 날짜로 읽을 수 없으므로 "마감 없음"으로 보고 문장을 덧붙인다.
// excludeNames는 모든 구역에서, dedupeNames는 오늘을 뺀 구역에서만 제외한다(이미 다른 줄로 보여 준 태스크를 되풀이하지 않기 위한 것).
export function classifyOpenTasks(
  tasks: { name: string; memo: string; deadline: string; done: boolean }[],
  today: string,
  excludeNames: ReadonlySet<string> = new Set(),
  windowDays = UPCOMING_DAYS,
  dedupeNames: ReadonlySet<string> = new Set(),
) {
  const last = addDays(today, windowDays);
  const result = {
    today: [] as { name: string; memo: string }[],
    upcoming: [] as { name: string; deadline: string; daysLeft: number }[],
    overdue: [] as { name: string; deadline: string; days: number }[],
    undated: [] as { name: string; note: string }[],
  };
  for (const t of tasks) {
    if (t.done || excludeNames.has(t.name)) continue;
    const shown = dedupeNames.has(t.name);
    if (!isYmd(t.deadline)) {
      if (!shown) result.undated.push({ name: t.name, note: t.deadline.trim() });
    } else if (t.deadline === today) {
      result.today.push({ name: t.name, memo: t.memo });
    } else if (t.deadline < today) {
      if (!shown) result.overdue.push({ name: t.name, deadline: t.deadline, days: daysBetween(t.deadline, today) });
    } else if (t.deadline <= last) {
      if (!shown) result.upcoming.push({ name: t.name, deadline: t.deadline, daysLeft: daysBetween(today, t.deadline) });
    }
  }
  result.upcoming.sort((a, b) => a.deadline.localeCompare(b.deadline));
  result.overdue.sort((a, b) => a.deadline.localeCompare(b.deadline));
  return result;
}

function monthDay(ymd: string): string {
  const [, m, d] = ymd.split('-');
  return ymd ? `${Number(m)}/${Number(d)}` : '없음';
}

function header(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('ko-KR', { timeZone, month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}(${get('weekday')}) 아침 보고`;
}

function clip(line: string, limit: number): string {
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

// 중요한 줄부터 순서대로 채운다. 한 통의 한도를 넘으면 다음 통으로 넘어가고,
// 통 수까지 넘으면 뒤쪽(덜 중요한) 줄을 빼고 "외 N건 생략"을 남긴다.
export function pack(lines: string[], limit: number, maxMessages: number): string[] {
  const chunks: string[][] = [[]];
  let omitted = 0;

  for (const raw of lines) {
    const line = clip(raw, limit);
    const current = chunks[chunks.length - 1];
    const size = [...current, line].join('\n').length;
    if (size <= limit) {
      current.push(line);
    } else if (chunks.length < maxMessages) {
      chunks.push([line]);
    } else {
      omitted += 1;
    }
  }

  while (omitted > 0) {
    const last = chunks[chunks.length - 1];
    const summary = `…외 ${omitted}건 생략`;
    if ([...last, summary].join('\n').length <= limit) {
      last.push(summary);
      break;
    }
    if (last.length <= 1) {
      // 생략 안내를 넣을 자리가 이 통에는 없다: 줄을 비우고 안내로 대체한다.
      last.length = 0;
      last.push(summary);
      omitted += 1;
      break;
    }
    last.pop();
    omitted += 1;
  }
  return chunks.map((c) => c.join('\n'));
}

// 한 구역을 최대 cap개까지 줄로 만들고, 넘으면 남은 개수를 한 줄로 알린다.
function section<T>(label: string, items: T[], render: (item: T) => string, cap = SECTION_CAP): string[] {
  const lines = items.slice(0, cap).map((item) => `${label}: ${render(item)}`);
  if (items.length > cap) lines.push(`${label}: 외 ${items.length - cap}건`);
  return lines;
}

// 같은 이름·같은 마감이 여러 번 기록된 "추가" 항목은 하나로 합치고 횟수를 붙인다.
function collapse(created: { name: string; deadline: string }[]): { name: string; deadline: string; times: number }[] {
  const map = new Map<string, { name: string; deadline: string; times: number }>();
  for (const c of created) {
    const key = `${c.name}\u0000${c.deadline}`;
    const found = map.get(key);
    if (found) found.times += 1;
    else map.set(key, { ...c, times: 1 });
  }
  return [...map.values()];
}

export function buildReport(input: ReportInput, limit: number, maxMessages = 3): string[] {
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const lines: string[] = [header(input.now, timeZone)];

  // 위에서부터 중요한 순서다. 카톡 분량이 모자라면 아래쪽부터 잘린다.
  const body: string[] = [];
  for (const f of input.failures) body.push(`⚠ 실패: ${f}`);
  for (const p of input.proposals) {
    body.push(`확인: '${p.name}' 마감 ${monthDay(p.currentDeadline)}→${monthDay(p.proposedDeadline)} 제안(벨루에서 직접 수정)`);
  }
  for (const u of input.uncertain) body.push(`확인: ${u}`);
  (input.top ?? []).forEach((t, i) => body.push(`먼저 ${i + 1}) ${t.name} — ${t.reason}`));
  for (const t of input.tasksToday) {
    const note = stripMarker(t.memo).split('\n')[0];
    body.push(`오늘: ${t.name}${note ? ` ${note}` : ''}`);
  }
  body.push(
    ...section('밀린 일', input.overdue ?? [], (t) => `${t.name}(${monthDay(t.deadline)}${t.days !== undefined ? `, ${t.days}일째` : ''})`),
  );
  body.push(
    ...section('임박', input.upcoming ?? [], (t) => `${t.name}(${monthDay(t.deadline)}${t.daysLeft !== undefined ? `·${t.daysLeft}일 후` : ''})`),
  );
  body.push(...section('메일 마감', input.mailDeadlines ?? [], (t) => `${t.name}(${monthDay(t.deadline)}·${t.daysLeft}일 후)`, SMALL_CAP));
  body.push(...section('방치', input.stale ?? [], (t) => `${t.name}(${t.days}일째)`, 2));
  if (input.papers && input.papers.count > 0) {
    body.push(`폴리오: 이번 주 새 논문 ${input.papers.count}편 — ${input.papers.titles.map((t) => clip(t, TITLE_LIMIT)).join(', ')}`);
  }
  if (input.weekly) body.push(`지난주: 완료 ${input.weekly.completed} · 생성 ${input.weekly.created} · 밀림 ${input.weekly.overdue}`);
  body.push(...section('추가', collapse(input.created), (c) => `${c.name}(${monthDay(c.deadline)})${c.times > 1 ? ` ×${c.times}` : ''}`));
  body.push(...section('할 일', input.undated ?? [], (t) => (t.note ? `${t.name}(${t.note})` : t.name)));
  for (const n of input.notes ?? []) body.push(`참고: ${n}`);

  if (body.length === 0) body.push('오늘 일정 없음. 추가·확인할 사항도 없어요.');
  else if (input.tasksToday.length === 0) body.push('오늘 마감인 일정은 없어요.');

  return pack([...lines, ...body], limit, maxMessages);
}
