export type ReportInput = {
  now: Date;
  timeZone?: string;
  tasksToday: { name: string; memo: string }[];
  created: { name: string; deadline: string }[];
  proposals: { name: string; currentDeadline: string; proposedDeadline: string }[];
  uncertain: string[];
  failures: string[];
  notes?: string[];
};

const DEFAULT_TIME_ZONE = 'Asia/Seoul';

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

export function buildReport(input: ReportInput, limit: number, maxMessages = 3): string[] {
  const timeZone = input.timeZone ?? DEFAULT_TIME_ZONE;
  const lines: string[] = [header(input.now, timeZone)];

  const body: string[] = [];
  for (const f of input.failures) body.push(`⚠ 실패: ${f}`);
  for (const p of input.proposals) {
    body.push(`확인: '${p.name}' 마감 ${monthDay(p.currentDeadline)}→${monthDay(p.proposedDeadline)} 제안(벨루에서 직접 수정)`);
  }
  for (const u of input.uncertain) body.push(`확인: ${u}`);
  for (const c of input.created) body.push(`추가: ${c.name}(${monthDay(c.deadline)})`);
  for (const t of input.tasksToday) body.push(`오늘: ${t.name}${t.memo ? ` ${t.memo.split('\n')[0]}` : ''}`);
  for (const n of input.notes ?? []) body.push(`참고: ${n}`);

  if (body.length === 0) body.push('오늘 일정 없음. 추가·확인할 사항도 없어요.');
  else if (input.tasksToday.length === 0) body.push('오늘 마감인 일정은 없어요.');

  return pack([...lines, ...body], limit, maxMessages);
}
