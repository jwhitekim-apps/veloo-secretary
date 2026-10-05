import { lastWeekStart, mailDeadlines, pickTopTasks, rankTasks, staleTasks } from '../domain/brief.js';
import { trackNewPapers, type Paper } from '../domain/papers.js';
import type { Candidate, Source, SyncResult } from '../domain/ledger.js';
import type { MailTriageResult } from '../domain/mail.js';
import { buildReport, classifyOpenTasks } from '../domain/report.js';
import type { Store } from '../adapters/store.js';

export type DailyDeps = {
  now: Date;
  timeZone?: string;
  store: Store;
  veloo: {
    listTasks(): Promise<
      { id: number; name: string; memo: string; priority: string; deadline: string; done: boolean; created_at?: string }[]
    >;
    weeklyReview?(weekStart: string): Promise<{ completed: number; created: number; overdue: number }>;
  };
  // 오늘 먼저 할 일 3개를 고르고 이유를 쓰는 모델 호출. 없거나 실패하면 규칙 순위로 대신한다.
  generateJson?: (request: { prompt: string; schema: object }) => Promise<unknown>;
  // 폴리오 논문 목록(읽기 전용). 없으면 폴리오 줄을 만들지 않는다.
  folio?: { recentPapers(): Promise<Paper[]> } | null;
  kakao: { send(text: string): Promise<void> };
  mail: (() => Promise<MailTriageResult>) | null;
  sync: (candidates: Candidate[], source: Source) => Promise<SyncResult>;
  limit: number;
  maxMessages?: number;
  notes?: string[];
  // true면 보고 내용만 만든다: 카톡을 보내지 않고, 벨루·처리 이력·보낸 시각 어디에도 쓰지 않는다.
  // 추가될 태스크는 "예정"으로만 보고에 보인다.
  dryRun?: boolean;
};

export type DailyOutcome = { messages: string[]; sent: boolean; failures: string[] };

const DEFAULT_TIME_ZONE = 'Asia/Seoul';
// 보낸 기록이 없을 때(첫 실행이거나 전송이 계속 실패한 경우) 되짚어 볼 기간. Cron 시각이 조금 어긋나도 놓치지 않도록 넉넉하게 잡는다.
const FALLBACK_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// 처리 기록에서 한 종류(kind)로 만든 태스크의 번호를 모은다. 읽지 못하면 비어 있는 것으로 본다.
async function readTaskIds(store: Store, kind: string): Promise<Set<number>> {
  try {
    const ids = new Set<number>();
    for (const e of await store.list(kind, '1970-01-01T00:00:00.000Z')) {
      const id = (e.data as { taskId?: unknown } | null)?.taskId;
      if (typeof id === 'number') ids.add(id);
    }
    return ids;
  } catch {
    return new Set();
  }
}

type Data = { name?: string; deadline?: string; taskId?: number; message?: string; currentDeadline?: string; proposedDeadline?: string };

// 매일 아침 한 번: 메일을 선별해 벨루에 반영하고, 오늘 일정과 처리 내역을 카톡으로 보고한다.
// 어떤 단계가 실패해도 나머지는 계속 진행하고, 실패는 숨기지 않고 보고에 올린다.
export async function runDaily(deps: DailyDeps): Promise<DailyOutcome> {
  const timeZone = deps.timeZone ?? DEFAULT_TIME_ZONE;
  const nowIso = deps.now.toISOString();
  const { store } = deps;
  const failures: string[] = [];
  const notes = [...(deps.notes ?? [])];
  let counter = 0;

  // 실패는 이번 보고에 바로 쓰고, 보고가 나가지 못해도 다음 실행에서 다시 보이도록 저장소에도 남긴다.
  async function fail(text: string): Promise<void> {
    failures.push(text);
    if (deps.dryRun) return;
    try {
      await store.record('failure', `run-${nowIso}-${counter++}`, { message: text });
    } catch {
      // 저장소가 실패해도 이번 보고에는 이미 들어 있다.
    }
  }

  const lastReport = await store.getState('last_report_at').catch(() => null);
  const since = lastReport ?? new Date(deps.now.getTime() - FALLBACK_LOOKBACK_MS).toISOString();

  // 1) 메일 선별 → 벨루 반영
  const uncertain: string[] = [];
  const preview: { name: string; deadline: string }[] = [];
  if (deps.mail) {
    try {
      const triage = await deps.mail();
      uncertain.push(...triage.uncertain);
      for (const f of triage.failures) await fail(f);
      if (deps.dryRun) {
        // 시험 실행: 무엇이 추가될지만 보여 주고 아무것도 쓰지 않는다.
        for (const c of triage.candidates) {
          for (const t of c.tasks) preview.push({ name: `${t.name} (예정, 저장 안 함)`, deadline: t.deadline });
        }
      } else {
        for (const id of triage.notImportantIds) await store.record('mail-seen', id, { at: nowIso }).catch(() => false);
        for (const c of triage.candidates) {
          const synced = await deps.sync(c.tasks, { kind: 'mail', id: c.mailId });
          for (const f of synced.failed) await fail(`벨루 쓰기 실패: ${f.candidate.name} (${f.error})`);
          notes.push(...synced.warnings);
          // 쓰기에 실패한 메일은 "본 메일"로 표시하지 않아서 다음 실행에서 다시 시도한다.
          if (synced.failed.length === 0) await store.record('mail-seen', c.mailId, { at: nowIso }).catch(() => false);
        }
      }
    } catch (e) {
      await fail(`메일 선별 실패: ${errorText(e)}`);
    }
  }

  // 2) 벨루의 남은 일(오늘·임박·밀린 일·마감 없음은 3번에서 나눈다)
  const today = localDate(deps.now, timeZone);
  let openTasks: Awaited<ReturnType<DailyDeps['veloo']['listTasks']>> = [];
  // 벨루에 지금 있는 태스크 번호. 읽지 못하면 null이고, 그때는 처리 기록을 걸러 낼 수 없다.
  let liveIds: Set<number> | null = null;
  try {
    openTasks = await deps.veloo.listTasks();
    liveIds = new Set(openTasks.map((t) => t.id));
  } catch (e) {
    await fail(`벨루 읽기 실패: ${errorText(e)}`);
  }

  // 3) 지난 보고 이후의 처리 내역
  let created: { name: string; deadline: string }[] = [];
  let proposals: { name: string; currentDeadline: string; proposedDeadline: string }[] = [];
  let storedFailures: string[] = [];
  let newestMs = deps.now.getTime();
  try {
    const written = [...(await store.list('mail', since)), ...(await store.list('intake', since))];
    // 처리 기록은 벨루와 따로 남아 있어서, 사용자가 벨루에서 지운 태스크도 기록에는 있다.
    // 지금 벨루에 없는 태스크는 보고하지 않는다(벨루를 읽지 못했을 때만 걸러 내지 못한다).
    const stillThere = (taskId: number | undefined) => liveIds === null || (typeof taskId === 'number' && liveIds.has(taskId));
    created = written
      .map((e) => e.data as Data)
      .filter((d) => typeof d?.taskId === 'number' && stillThere(d.taskId))
      .map((d) => ({ name: d.name ?? '', deadline: d.deadline ?? '' }));
    const proposalEntries = await store.list('proposal', since);
    proposals = proposalEntries
      .map((e) => e.data as Data)
      .filter((d) => stillThere(d.taskId))
      .map((d) => ({ name: d.name ?? '', currentDeadline: d.currentDeadline ?? '', proposedDeadline: d.proposedDeadline ?? '' }));
    const failureEntries = await store.list('failure', since);
    storedFailures = failureEntries.map((e) => (e.data as Data).message ?? '');
    for (const e of [...written, ...proposalEntries, ...failureEntries]) {
      newestMs = Math.max(newestMs, Date.parse(e.at));
    }
  } catch (e) {
    failures.push(`처리 내역 읽기 실패: ${errorText(e)}`);
  }
  created.push(...preview);

  // 4) 브리핑 재료: 오늘 먼저 할 일, 방치된 일, 메일 마감, 지난주 통계, 폴리오 새 논문
  const top = await pickTopTasks(rankTasks(openTasks, today, timeZone), today, deps.generateJson);
  const stale = staleTasks(openTasks, today, timeZone);
  const mailDeadlineList = mailDeadlines(openTasks, today, await readTaskIds(store, 'mail'));

  let weekly: { completed: number; created: number; overdue: number } | null = null;
  if (deps.veloo.weeklyReview && liveIds !== null) {
    try {
      weekly = await deps.veloo.weeklyReview(lastWeekStart(today));
    } catch (e) {
      notes.push(`지난주 통계를 읽지 못함(${errorText(e)})`);
    }
  }

  let papers: { count: number; titles: string[] } | null = null;
  if (deps.folio) {
    try {
      papers = await trackNewPapers(await deps.folio.recentPapers(), store, deps.now, { dryRun: deps.dryRun });
    } catch (e) {
      notes.push(`폴리오를 읽지 못함(${errorText(e)})`);
    }
  }

  // 이미 다른 줄로 보여 준 태스크("추가", "먼저")는 다른 구역에 되풀이하지 않는다. 오늘 마감은 항상 보여 준다.
  const createdNames = new Set(created.map((c) => c.name.replace(' (예정, 저장 안 함)', '')));
  const sections = classifyOpenTasks(openTasks, today, createdNames, undefined, new Set(top.map((t) => t.name)));
  const allFailures = [...new Set([...failures, ...storedFailures].filter(Boolean))];

  const messages = buildReport(
    {
      now: deps.now,
      timeZone,
      top,
      tasksToday: sections.today,
      upcoming: sections.upcoming,
      overdue: sections.overdue,
      undated: sections.undated,
      stale,
      mailDeadlines: mailDeadlineList,
      weekly,
      papers,
      created,
      proposals,
      uncertain,
      failures: allFailures,
      notes,
    },
    deps.limit,
    deps.maxMessages ?? 3,
  );
  if (deps.dryRun) return { messages, sent: false, failures: allFailures };

  // 4) 전송
  try {
    for (const message of messages) await deps.kakao.send(message);
  } catch (e) {
    const text = `보고 전송 실패: ${errorText(e)}`;
    await store.record('failure', `send-${nowIso}`, { message: text }).catch(() => false);
    return { messages, sent: false, failures: [...allFailures, text] };
  }
  try {
    // 이번 보고에 담은 가장 늦은 항목 바로 다음 시각을 저장한다. 다음 조회는 "엄격히 이후"만 가져오므로 같은 항목이 두 번 보고되지 않는다.
    await store.setState('last_report_at', new Date(newestMs + 1).toISOString());
  } catch (e) {
    return { messages, sent: true, failures: [...allFailures, `보낸 시각 저장 실패: ${errorText(e)}`] };
  }
  return { messages, sent: true, failures: allFailures };
}
