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

// 보고의 한 구역: 이름 한 줄 아래에 항목을 한 줄씩 적는다. 이름이 비어 있으면 항목만 적는 줄이다.
type Section = { title: string; items: string[] };

// 말풍선이 여럿일 때 붙이는 쪽 표시("(2/3)")가 차지할 자리. 모든 말풍선이 이만큼 덜 채워진다.
const PAGE_TAG_RESERVE = 8;

function renderSection(section: Section): string {
  return section.title ? [`[${section.title}]`, ...section.items].join('\n') : section.items.join('\n');
}

// 첫 조각이 현재 말풍선의 남은 자리에 넣기에 너무 작으면(이름과 항목 하나도 못 담으면) 새 말풍선에서 시작한다.
const MIN_PIECE = 24;

// 구역을 중요한 순서대로 말풍선에 채운다. 구역은 쪼개지 않고, 다음 구역이 안 들어가면 다음 말풍선으로 넘긴다.
// 구역 하나가 말풍선 하나보다 길 때만 항목 단위로 나누고, 첫 조각은 현재 말풍선의 남은 자리를 쓰며,
// 이어지는 조각에는 "(이어서)"를 붙여 구역 이름을 다시 적는다.
// 통 수를 넘으면 그 구역부터 뒤쪽 구역을 통째로 빼고 "…외 N건 생략"을 남긴다(중요도 순서는 뒤바뀌지 않는다).
// 말풍선이 둘 이상이면 머리말에 "(1/3)"을, 나머지 말풍선 맨 앞에 "(2/3)"을 붙인다.
export function packSections(header: string, sections: Section[], limit: number, maxMessages: number): string[] {
  const capacity = limit - PAGE_TAG_RESERVE;
  const size = (blocks: string[]) => blocks.join('\n\n').length;
  const bubbles: string[][] = [[clip(header, capacity)]];
  let omitted = 0;
  let full = false;

  // 블록 하나를 현재 말풍선에, 안 들어가면 새 말풍선에 둔다. 통 수가 다 찼으면 빠진 항목 수만 센다.
  const place = (block: string, itemCount: number, forceNew = false): void => {
    const last = bubbles[bubbles.length - 1];
    if (!forceNew && size([...last, block]) <= capacity) last.push(block);
    else if (bubbles.length < maxMessages) bubbles.push([block]);
    else {
      full = true;
      omitted += itemCount;
    }
  };

  for (const section of sections) {
    if (full) {
      omitted += section.items.length;
      continue;
    }
    const whole = renderSection(section);
    if (whole.length <= capacity) {
      place(whole, section.items.length);
      continue;
    }

    // 말풍선 하나에도 안 들어가는 구역: 항목 단위로 나눈다.
    const remaining = capacity - size(bubbles[bubbles.length - 1]) - 2;
    const startNew = remaining < MIN_PIECE;
    let room = startNew ? capacity : remaining;
    let pieceIndex = 0;
    let items: string[] = [];
    const titleOf = () => (pieceIndex === 0 ? section.title : `${section.title} (이어서)`);
    const flush = () => {
      if (items.length === 0) return;
      place(renderSection({ title: titleOf(), items }), items.length, pieceIndex === 0 && startNew);
      pieceIndex += 1;
      items = [];
      room = capacity;
    };
    for (const raw of section.items) {
      if (full) {
        omitted += 1;
        continue;
      }
      const item = clip(raw, Math.max(10, capacity - titleOf().length - 4));
      if (items.length > 0 && renderSection({ title: titleOf(), items: [...items, item] }).length > room) {
        flush();
        if (full) {
          omitted += 1;
          continue;
        }
      }
      items.push(item);
    }
    flush();
  }

  if (omitted > 0) {
    const last = bubbles[bubbles.length - 1];
    const summary = () => `…외 ${omitted}건 생략`;
    // 안내가 들어갈 자리가 없으면 이 통의 뒤쪽 항목을 줄이면서 그만큼 개수에 더한다.
    while (size([...last, summary()]) > capacity) {
      const lines = last[last.length - 1].split('\n');
      if (last.length === 1 && lines.length <= 1) break; // 머리말만 남았다
      if (lines.length > 2) {
        lines.pop();
        omitted += 1;
        last[last.length - 1] = lines.join('\n');
      } else {
        omitted += lines.length > 1 ? 1 : 0;
        last.pop();
        if (last.length === 0) break;
      }
    }
    last.push(summary());
  }

  const total = bubbles.length;
  return bubbles.map((blocks, index) => {
    if (total === 1) return blocks.join('\n\n');
    if (index === 0) return [`${blocks[0]} (1/${total})`, ...blocks.slice(1)].join('\n\n');
    return [`(${index + 1}/${total})`, ...blocks].join('\n\n');
  });
}

// 한 구역을 최대 cap개까지 항목으로 만들고, 넘으면 남은 개수를 항목 하나로 알린다.
function capped<T>(items: T[], render: (item: T) => string, cap = SECTION_CAP): string[] {
  const lines = items.slice(0, cap).map((item) => `· ${render(item)}`);
  if (items.length > cap) lines.push(`· 외 ${items.length - cap}건`);
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
  const sections: Section[] = [];
  const add = (title: string, items: string[]) => {
    if (items.length > 0) sections.push({ title, items });
  };

  // 위에서부터 중요한 순서다. 카톡 분량이 모자라면 아래쪽 구역부터 통째로 빠진다.
  add('⚠ 실패', input.failures.map((f) => `· ${f}`));
  add('확인', [
    ...input.proposals.map((p) => `· '${p.name}' 마감 ${monthDay(p.currentDeadline)}→${monthDay(p.proposedDeadline)} 제안(벨루에서 직접 수정)`),
    ...input.uncertain.map((u) => `· ${u}`),
  ]);
  add('먼저 할 일', (input.top ?? []).map((t, i) => `${i + 1}) ${t.name} — ${t.reason}`));
  add(
    '오늘',
    input.tasksToday.map((t) => {
      const note = stripMarker(t.memo).split('\n')[0];
      return `· ${t.name}${note ? ` ${note}` : ''}`;
    }),
  );
  add('밀린 일', capped(input.overdue ?? [], (t) => `${t.name}(${monthDay(t.deadline)}${t.days !== undefined ? `, ${t.days}일째` : ''})`));
  add('임박', capped(input.upcoming ?? [], (t) => `${t.name}(${monthDay(t.deadline)}${t.daysLeft !== undefined ? `·${t.daysLeft}일 후` : ''})`));
  add('메일 마감', capped(input.mailDeadlines ?? [], (t) => `${t.name}(${monthDay(t.deadline)}·${t.daysLeft}일 후)`, SMALL_CAP));
  add('방치', capped(input.stale ?? [], (t) => `${t.name}(${t.days}일째)`, 2));
  if (input.papers && input.papers.count > 0) {
    add(`폴리오 · 이번 주 새 논문 ${input.papers.count}편`, input.papers.titles.map((t) => `· ${clip(t, TITLE_LIMIT)}`));
  }
  if (input.weekly) add('지난주', [`· 완료 ${input.weekly.completed} · 생성 ${input.weekly.created} · 밀림 ${input.weekly.overdue}`]);
  add(
    '추가',
    capped(collapse(input.created), (c) => `${c.name}(${c.deadline ? monthDay(c.deadline) : '마감 없음'})${c.times > 1 ? ` ×${c.times}` : ''}`),
  );
  add('할 일', capped(input.undated ?? [], (t) => (t.note ? `${t.name}(${t.note})` : t.name)));
  add('참고', (input.notes ?? []).map((n) => `· ${n}`));

  if (sections.length === 0) sections.push({ title: '', items: ['오늘 일정 없음. 추가·확인할 사항도 없어요.'] });
  else if (input.tasksToday.length === 0) sections.push({ title: '', items: ['오늘 마감인 일정은 없어요.'] });

  return packSections(header(input.now, timeZone), sections, limit, maxMessages);
}
