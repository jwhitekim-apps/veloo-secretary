export type Priority = 'low' | 'normal' | 'high';
export type Task = { name: string; deadline: string; priority: Priority; memo: string };

export type GenerateJson = (request: {
  prompt: string;
  schema: object;
  image?: { data: string; mimeType: string };
}) => Promise<unknown>;

export type InterpretDeps = { generateJson: GenerateJson; now: Date; timeZone?: string };
export type InterpretResult =
  | { message: string; tasks: Task[]; assumptions: string[]; unreadable: string[] }
  | { error: string };

const DEFAULT_TIME_ZONE = 'Asia/Seoul';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const PRIORITIES: readonly string[] = ['low', 'normal', 'high'];

const SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          deadline: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high'] },
          memo: { type: 'string' },
        },
        required: ['name', 'deadline', 'priority', 'memo'],
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    unreadable: { type: 'array', items: { type: 'string' } },
  },
  required: ['tasks', 'assumptions', 'unreadable'],
};

function localDate(now: Date, timeZone: string): string {
  // 'en-CA' 로케일은 YYYY-MM-DD 형태로 출력한다.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

// 상대 표현을 모델이 계산하지 않고 표에서 찾을 수 있도록, 오늘부터 14일치 달력을 만든다.
export function calendarHint(now: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const [y, m, d] = localDate(now, timeZone).split('-').map(Number);
  const lines: string[] = [];
  for (let i = 0; i < 14; i++) {
    const day = new Date(Date.UTC(y, m - 1, d + i));
    const label = i === 0 ? ' 오늘' : i === 1 ? ' 내일' : '';
    lines.push(`${day.toISOString().slice(0, 10)} (${WEEKDAYS[day.getUTCDay()]})${label}`);
  }
  return lines.join('\n');
}

function buildPrompt(now: Date, timeZone: string, text: string, hasImage: boolean): string {
  const rules = [
    '너는 개인 비서다. 입력에서 일정, 마감, 할 일을 모두 찾아 tasks에 담아라. 관련 없는 내용은 무시하고, 없으면 tasks는 빈 배열이다.',
    '- name: 짧은 제목. deadline: YYYY-MM-DD, 날짜를 알 수 없으면 빈 문자열.',
    '- 시각이 있으면 memo에 "15:00"처럼 24시간 형식으로 적고, 장소 등 부가 정보도 memo에 적는다. 없으면 빈 문자열.',
    '- priority: "급함"처럼 서두르라는 표현은 high, 여유 있다는 표현은 low, 그 외는 normal.',
    '- 요일만 말하면 아래 달력에서 오늘 이후 가장 가까운 그 요일(오늘이 같은 요일이면 오늘)이다. "다음 주 X요일"은 다음 주의 그 요일이다.',
    '- "이번 주 안에"는 이번 주 일요일이다. 날짜는 반드시 아래 달력에서 찾아라.',
    '- 날짜가 입력에 없으면 지어내지 말고 deadline을 빈 문자열로 둔다.',
    '- 이미지에서 가려졌거나 잘렸거나 읽기 어려운 부분은 추측하지 말고 unreadable에 한 줄씩 적어라.',
    '- assumptions에는 입력에 정보가 없어서 네가 기본값을 정한 경우만 적어라. 예: "날짜 언급 없음 → 마감 없음". 요일이나 상대 날짜를 달력으로 계산한 것은 추정이 아니므로 적지 마라.',
    '- assumptions와 unreadable의 각 항목은 40자 이내로 짧게 써라.',
  ].join('\n');

  const parts = [rules, `\n현재 시간대: ${timeZone}\n달력:\n${calendarHint(now, timeZone)}`];
  if (text) parts.push(`\n입력 문장:\n"""${text}"""`);
  if (hasImage) parts.push('\n첨부된 이미지는 화면 캡처다. 이미지 안의 일정을 읽어라.');
  return parts.join('\n');
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function parseOutput(raw: unknown, today: string) {
  const o = raw as { tasks?: unknown; assumptions?: unknown; unreadable?: unknown } | null;
  if (!o || !Array.isArray(o.tasks) || !isStringArray(o.assumptions) || !isStringArray(o.unreadable)) {
    throw new Error('model returned an invalid structure');
  }
  const assumptions = [...o.assumptions];
  const tasks: Task[] = [];

  for (const item of o.tasks as Record<string, unknown>[]) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    let deadline = typeof item.deadline === 'string' ? item.deadline : '';
    if (deadline && !isValidDate(deadline)) {
      assumptions.push(`${name}: 날짜 형식을 알 수 없어 마감 없음으로 처리`);
      deadline = '';
    } else if (deadline && deadline < today) {
      assumptions.push(`${name}: ${deadline}는 지난 날짜라 마감 없음으로 처리`);
      deadline = '';
    }
    const priority = PRIORITIES.includes(item.priority as string) ? (item.priority as Priority) : 'normal';
    const memo = typeof item.memo === 'string' ? item.memo.trim() : '';
    tasks.push({ name, deadline, priority, memo });
  }
  return { tasks, assumptions, unreadable: o.unreadable };
}

export function describeTask(task: { name: string; deadline: string; memo: string }): string {
  const [, month, day] = task.deadline.split('-');
  const parts = [task.deadline ? `${Number(month)}/${Number(day)}` : '마감 없음'];
  if (task.memo) parts.push(task.memo);
  return `${task.name}(${parts.join(', ')})`;
}

export function buildMessage(
  tasks: Task[],
  assumptions: string[],
  unreadable: string[],
  lead = '인식한 일정',
): string {
  let message = tasks.length
    ? `${lead} ${tasks.length}건: ${tasks.map(describeTask).join(' / ')}.`
    : '일정을 찾지 못했어요.';
  if (assumptions.length) message += ` 추정: ${assumptions.join('; ')}.`;
  if (unreadable.length) message += ` 읽을 수 없음: ${unreadable.join('; ')}.`;
  return message;
}

// 모델을 부르지 않고 입력만 검사한다. 문제가 있으면 오류 문장을, 없으면 null을 돌려준다.
export function validateInput(input: unknown): string | null {
  const body = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const imageData = typeof body.image === 'string' ? body.image : '';
  return text || imageData ? null : 'text or image is required';
}

export async function interpretInput(input: unknown, deps: InterpretDeps): Promise<InterpretResult> {
  const timeZone = deps.timeZone ?? DEFAULT_TIME_ZONE;
  const invalid = validateInput(input);
  if (invalid) return { error: invalid };
  const body = input as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const imageData = typeof body.image === 'string' ? body.image : '';

  const mimeType = typeof body.mimeType === 'string' && body.mimeType ? body.mimeType : 'image/jpeg';
  const raw = await deps.generateJson({
    prompt: buildPrompt(deps.now, timeZone, text, Boolean(imageData)),
    schema: SCHEMA,
    image: imageData ? { data: imageData, mimeType } : undefined,
  });

  const { tasks, assumptions, unreadable } = parseOutput(raw, localDate(deps.now, timeZone));
  return { message: buildMessage(tasks, assumptions, unreadable), tasks, assumptions, unreadable };
}
