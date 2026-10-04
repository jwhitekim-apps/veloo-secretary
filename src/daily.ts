import type { Candidate, Source, SyncResult } from './ledger.js';
import type { MailTriageResult } from './mail.js';
import { buildReport, classifyOpenTasks } from './report.js';
import type { Store } from './store.js';

export type DailyDeps = {
  now: Date;
  timeZone?: string;
  store: Store;
  veloo: { listTasks(): Promise<{ name: string; memo: string; deadline: string; done: boolean }[]> };
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
  let openTasks: { name: string; memo: string; deadline: string; done: boolean }[] = [];
  try {
    openTasks = await deps.veloo.listTasks();
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
    created = written
      .map((e) => e.data as Data)
      .filter((d) => typeof d?.taskId === 'number')
      .map((d) => ({ name: d.name ?? '', deadline: d.deadline ?? '' }));
    const proposalEntries = await store.list('proposal', since);
    proposals = proposalEntries.map((e) => {
      const d = e.data as Data;
      return { name: d.name ?? '', currentDeadline: d.currentDeadline ?? '', proposedDeadline: d.proposedDeadline ?? '' };
    });
    const failureEntries = await store.list('failure', since);
    storedFailures = failureEntries.map((e) => (e.data as Data).message ?? '');
    for (const e of [...written, ...proposalEntries, ...failureEntries]) {
      newestMs = Math.max(newestMs, Date.parse(e.at));
    }
  } catch (e) {
    failures.push(`처리 내역 읽기 실패: ${errorText(e)}`);
  }
  created.push(...preview);
  // 이번 보고의 "추가" 항목은 다른 구역에 중복해서 보여 주지 않는다.
  const sections = classifyOpenTasks(openTasks, today, new Set(created.map((c) => c.name.replace(' (예정, 저장 안 함)', ''))));
  const allFailures = [...new Set([...failures, ...storedFailures].filter(Boolean))];

  const messages = buildReport(
    {
      now: deps.now,
      timeZone,
      tasksToday: sections.today,
      upcoming: sections.upcoming,
      overdue: sections.overdue,
      undated: sections.undated,
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
