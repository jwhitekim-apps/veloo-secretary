export type Priority = 'low' | 'normal' | 'high';
export type Task = { name: string; deadline: string; priority: Priority; memo: string };

export type GenerateJson = (request: {
  prompt: string;
  schema: object;
  image?: { data: string; mimeType: string };
  quality?: 'high';
}) => Promise<unknown>;

export type InterpretDeps = {
  generateJson: GenerateJson;
  now: Date;
  timeZone?: string;
  quality?: 'high';
  // true이면 가벼운 모델이 "손글씨가 있다"고 답한 이미지를 더 큰 모델로 다시 읽는다(큰 모델이 설정되어 있을 때만 켠다).
  escalate?: boolean;
};
export type InterpretResult =
  | { message: string; tasks: Task[]; assumptions: string[]; unreadable: string[]; transcript: string; escalated?: boolean }
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
    transcript: { type: 'string' },
    handwritten: { type: 'boolean' },
  },
  required: ['tasks', 'assumptions', 'unreadable', 'transcript', 'handwritten'],
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
    '- 입력이 이미지이면 먼저 이미지에 보이는 글을 위에서 아래로 **보이는 그대로** transcript에 옮겨 적어라(300자 이내). 뜻이 통하게 고치거나, 비슷한 단어로 바꾸거나, 요약하지 마라. 입력이 텍스트이면 transcript는 빈 문자열이다.',
    '- handwritten: 이미지에서 일정이나 할 일을 담은 부분이 손으로 쓴 글씨이면 true, 인쇄된 글자나 화면 글자(메신저 대화, 웹페이지 등)뿐이면 false. 텍스트 입력이면 false.',
    '- 손글씨는 글자 모양을 보고 읽되, 확신이 없는 글자는 아는 단어로 짐작해서 바꾸지 말고 보이는 모양 그대로 두고 unreadable에 적어라.',
    '- name은 원문의 표현을 최대한 그대로 쓴다. 풀어 쓰거나 다른 말로 바꾸지 마라. 어미(~하고, ~하기)만 짧게 정리할 수 있다.',
    '- 한 입력에 항목이 여러 개이면(줄 구분, 번호, 체크박스, 슬래시, 점, 쉼표로 이은 목록) 항목마다 따로 task로 만들어라. 하나도 빠뜨리지 마라.',
  ].join('\n');

  const parts = [rules, `\n현재 시간대: ${timeZone}\n달력:\n${calendarHint(now, timeZone)}`];
  if (text) parts.push(`\n입력 문장:\n"""${text}"""`);
  if (hasImage) parts.push('\n첨부된 이미지는 화면 캡처이거나 카메라로 찍은 사진(손글씨 메모, 포스터, 칠판, 종이 일정표 등)이다. 이미지 안의 일정과 할 일을 읽어라.');
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
  const transcript = typeof (raw as { transcript?: unknown }).transcript === 'string' ? ((raw as { transcript: string }).transcript).trim() : '';
  const handwritten = (raw as { handwritten?: unknown }).handwritten === true;
  return { tasks, assumptions, unreadable: o.unreadable, transcript, handwritten };
}

export function describeTask(task: { name: string; deadline: string; memo: string }): string {
  const [, month, day] = task.deadline.split('-');
  const parts = [task.deadline ? `${Number(month)}/${Number(day)}` : '마감 없음'];
  if (task.memo) parts.push(task.memo);
  return `${task.name}(${parts.join(', ')})`;
}

// 이미지에서 읽은 글을 응답에 덧붙인다. 잘못 읽은 글자를 사용자가 바로 알아볼 수 있게 하기 위한 것이다.
export function readBackText(transcript: string, limit = 100): string {
  const text = transcript.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return ` 읽은 내용: "${text.length <= limit ? text : `${text.slice(0, limit - 1)}…`}".`;
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
  const request = {
    prompt: buildPrompt(deps.now, timeZone, text, Boolean(imageData)),
    schema: SCHEMA,
    image: imageData ? { data: imageData, mimeType } : undefined,
  };
  const today = localDate(deps.now, timeZone);

  let parsed = parseOutput(await deps.generateJson({ ...request, quality: deps.quality }), today);

  // 손글씨는 가벼운 모델이 틀리고도 확신 있게 틀리므로(비교 시험), 손글씨라고 답한 이미지는 큰 모델로 다시 읽는다.
  // 이미 고품질을 요청했거나(처음부터 큰 모델) 텍스트 입력이면 하지 않는다.
  let escalated = false;
  if (imageData && deps.escalate && !deps.quality && parsed.handwritten) {
    try {
      parsed = parseOutput(await deps.generateJson({ ...request, quality: 'high' }), today);
      escalated = true;
    } catch {
      parsed.assumptions.push('손글씨를 큰 모델로 다시 읽지 못해 기본 결과를 씀');
    }
  }

  const { tasks, assumptions, unreadable, transcript } = parsed;
  const readBack = imageData ? readBackText(transcript) : '';
  return { message: buildMessage(tasks, assumptions, unreadable) + readBack, tasks, assumptions, unreadable, transcript, escalated };
}
