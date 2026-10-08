type MailMeta = { id: string; subject: string; from: string; date: string; snippet: string; threadId?: string; threadSubject?: string };
type Candidate = { name: string; deadline: string; priority: string; memo: string };
type Interpretation =
  | { tasks: Candidate[]; assumptions: string[]; unreadable: string[] }
  | { error: string };

export type MailDeps = {
  gmail: {
    search(query: string, max?: number): Promise<MailMeta[]>;
    readBody(id: string): Promise<string>;
  };
  generateJson(request: { prompt: string; schema: object }): Promise<unknown>;
  // 메일 한 통의 텍스트에서 일정을 뽑는다(src/interpret.ts의 interpretInput을 감싸서 넘긴다).
  interpret(text: string): Promise<Interpretation>;
  store: { has(kind: string, id: string): Promise<boolean> };
  keywords: string[];
  lookbackDays: number;
  max?: number;
};

export type MailTriageResult = {
  // 장부에 반영할 일. 마감이 불명확한 일은 마감을 비운 채 스레드당 하나로 합쳐 들어온다.
  // alsoMailIds: 이 후보에 합쳐진 같은 스레드의 다른 메일(반영에 성공하면 함께 "본 메일"로 남긴다).
  candidates: { mailId: string; subject: string; tasks: Candidate[]; alsoMailIds?: string[] }[];
  // 사람이 확인해야 하는 항목(읽을 수 없는 메일과 부분)
  uncertain: string[];
  // 중요하지 않다고 판단해서 더 볼 필요가 없는 메일(처리 이력에 "본 메일"로 남겨도 되는 것)
  notImportantIds: string[];
  // 처리 중 실패한 메일. 다음 실행에서 다시 시도한다.
  failures: string[];
  stats: { found: number; fresh: number; important: number };
};

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, important: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['id', 'important', 'reason'],
      },
    },
  },
  required: ['items'],
};

export function buildQuery(keywords: string[], lookbackDays: number): string {
  const terms = keywords.map((k) => k.trim().replace(/"/g, '')).filter(Boolean);
  if (terms.length === 0) throw new Error('No mail keywords configured');
  return `newer_than:${lookbackDays}d (${terms.map((k) => `"${k}"`).join(' OR ')})`;
}

function judgePrompt(metas: MailMeta[]): string {
  const list = metas
    .map((m) => `- id: ${m.id}\n  제목: ${m.subject}\n  보낸 사람: ${m.from}\n  요약: ${m.snippet}`)
    .join('\n');
  return [
    '너는 개인 비서다. 아래 메일 목록(제목, 보낸 사람, 요약만 있다)에서 사용자가 놓치면 곤란한 메일을 골라라.',
    '중요한 메일: 학회·논문 마감이나 공지, 교수·학교·기관의 요청이나 기한이 있는 연락, 일정이 확정된 안내.',
    '중요하지 않은 메일: 광고, 뉴스레터, 단순 알림, 이미 지난 일의 통보.',
    '모든 id에 대해 important 여부와 한 줄 이유를 답하라.',
    '',
    list,
  ].join('\n');
}

const TASK_NAME_LIMIT = 60;
const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);

type UndatedGroup = { title: string; mailIds: string[]; items: Candidate[] };

// 같은 스레드에서 마감을 모르는 일들을 하나의 태스크로 합친다. 모델이 같은 일을 호출마다 다른 이름으로 적어서 이름으로는 중복을 못 거른다.
// 일 이름이 하나뿐이면 그 이름을, 여럿이면 스레드에서 처음 받은 메일의 제목을 이름으로 쓴다.
function undatedCandidate(group: UndatedGroup): MailTriageResult['candidates'][number] {
  const names = [...new Set(group.items.map((i) => i.name))];
  const priority = group.items.some((i) => i.priority === 'high')
    ? 'high'
    : group.items.every((i) => i.priority === 'low')
      ? 'low'
      : 'normal';
  const note = `마감 확인 필요 · 메일: ${group.title}`;
  const task: Candidate =
    names.length === 1
      ? { name: clip(names[0], TASK_NAME_LIMIT), deadline: '', priority, memo: note }
      : { name: clip(group.title, TASK_NAME_LIMIT), deadline: '', priority, memo: [note, ...names.map((n) => `- ${n}`)].join('\n') };
  return { mailId: group.mailIds[0], alsoMailIds: group.mailIds.slice(1), subject: group.title, tasks: [task] };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function triageMail(deps: MailDeps): Promise<MailTriageResult> {
  const result: MailTriageResult = {
    candidates: [],
    uncertain: [],
    notImportantIds: [],
    failures: [],
    stats: { found: 0, fresh: 0, important: 0 },
  };

  const found = await deps.gmail.search(buildQuery(deps.keywords, deps.lookbackDays), deps.max ?? 25);
  result.stats.found = found.length;

  const fresh: MailMeta[] = [];
  for (const meta of found) {
    if (!(await deps.store.has('mail-seen', meta.id))) fresh.push(meta);
  }
  result.stats.fresh = fresh.length;
  if (fresh.length === 0) return result;

  // 1차: 제목·보낸 사람·요약만으로 판단한다. 본문은 중요하다고 본 메일에 한해서만 읽는다.
  const judged = (await deps.generateJson({ prompt: judgePrompt(fresh), schema: JUDGE_SCHEMA })) as {
    items?: { id: string; important: boolean }[];
  } | null;
  if (!judged || !Array.isArray(judged.items)) throw new Error('mail judge returned an invalid structure');
  const verdict = new Map(judged.items.map((i) => [i.id, i.important]));

  const undated = new Map<string, UndatedGroup>();
  for (const meta of fresh) {
    // 판단에서 빠진 메일은 놓치지 않도록 중요한 것으로 취급한다.
    if (verdict.get(meta.id) === false) {
      result.notImportantIds.push(meta.id);
      continue;
    }
    result.stats.important += 1;
    // 보고에는 스레드에서 처음 받은 메일의 제목을 쓴다. 답장이나 후속 메일이 다른 이름으로 따로 보이지 않게 하려는 것이다.
    const title = meta.threadSubject || meta.subject;
    try {
      const body = await deps.gmail.readBody(meta.id);
      const text = `메일 제목: ${meta.subject}\n보낸 사람: ${meta.from}\n받은 날짜: ${meta.date}\n\n${body}`;
      const interpreted = await deps.interpret(text);
      if ('error' in interpreted) {
        result.uncertain.push(`읽을 수 없는 메일: ${title}`);
        continue;
      }
      const sure = interpreted.tasks.filter((t) => t.deadline);
      const noDeadline = interpreted.tasks.filter((t) => !t.deadline);
      if (noDeadline.length) {
        const key = meta.threadId ?? meta.id;
        const group = undated.get(key) ?? { title, mailIds: [], items: [] };
        group.mailIds.push(meta.id);
        group.items.push(...noDeadline);
        undated.set(key, group);
      }
      for (const u of interpreted.unreadable) result.uncertain.push(`${title}: ${u}`);
      if (sure.length) result.candidates.push({ mailId: meta.id, subject: title, tasks: sure });
      else if (interpreted.tasks.length === 0) result.notImportantIds.push(meta.id);
    } catch (e) {
      result.failures.push(`메일 처리 실패(${title}): ${errorText(e)}`);
    }
  }
  for (const group of undated.values()) result.candidates.push(undatedCandidate(group));
  // 같은 스레드의 메일에서 똑같은 항목이 나오면 한 번만 보인다.
  result.uncertain = [...new Set(result.uncertain)];
  return result;
}
