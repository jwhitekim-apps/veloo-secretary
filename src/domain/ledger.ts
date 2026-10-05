type LedgerTask = { id: number; name: string; memo: string; deadline: string; done: boolean };
export type Candidate = { name: string; deadline: string; priority: string; memo: string };
export type Source = { kind: string; id: string };

export type LedgerDeps = {
  veloo: {
    listTasks(): Promise<LedgerTask[]>;
    createTask(task: Candidate): Promise<LedgerTask>;
  };
  store: {
    record(kind: string, id: string, data: unknown): Promise<boolean>;
    has(kind: string, id: string): Promise<boolean>;
    // 비서가 만든 태스크의 번호를 알아내는 데 쓴다. 없으면 모든 태스크를 사용자가 쓴 것으로 본다.
    list?(kind: string, sinceIso: string): Promise<{ data: unknown }[]>;
  };
};

export type SyncResult = {
  created: { candidate: Candidate; task: LedgerTask }[];
  skipped: { candidate: Candidate; reason: 'already-processed' | 'exists' }[];
  proposed: { candidate: Candidate; existing: LedgerTask }[];
  failed: { candidate: Candidate; error: string }[];
  warnings: string[];
};

// 예전에는 비서가 만든 태스크의 메모에 `[비서:…]` 표식을 붙였다. 이제는 쓰지 않지만, 이미 벨루에 있는 태스크를 알아보기 위해 읽기에는 남겨 둔다.
export const MARKER_PREFIX = '[비서:';

export function isAssistantTask(task: { memo: string }): boolean {
  return task.memo.includes(MARKER_PREFIX);
}

const EPOCH = '1970-01-01T00:00:00.000Z';

// 처리 기록에서 비서가 만든 태스크의 번호를 모은다. 기록을 읽지 못하면 비어 있는 것으로 본다(그 태스크는 사용자가 쓴 것으로 취급).
export async function loadAssistantTaskIds(store: Pick<LedgerDeps['store'], 'list'>): Promise<Set<number>> {
  const ids = new Set<number>();
  if (!store.list) return ids;
  for (const kind of ['intake', 'mail']) {
    try {
      for (const entry of await store.list(kind, EPOCH)) {
        const id = (entry.data as { taskId?: unknown } | null)?.taskId;
        if (typeof id === 'number') ids.add(id);
      }
    } catch {
      // 읽지 못한 종류는 건너뛴다.
    }
  }
  return ids;
}

function normalize(name: string): string {
  return name.replace(/[\s\p{P}]/gu, '').toLowerCase();
}

function sameName(a: string, b: string): boolean {
  const x = normalize(a);
  const y = normalize(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // 짧은 이름은 우연히 겹치기 쉬우므로 포함 관계는 세 글자 이상일 때만 같은 것으로 본다.
  return Math.min(x.length, y.length) >= 3 && (x.includes(y) || y.includes(x));
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 후보를 벨루에 반영한다. 비서가 하는 쓰기는 "생성"뿐이다.
// - 같은 출처(source.id#순번)는 한 번만 처리한다. 처리 이력은 벨루와 별도로 저장하므로,
//   사용자가 벨루에서 지운 태스크도 되살리지 않는다.
// - 사용자가 직접 쓴 비슷한 태스크가 있으면 새로 만들지 않고, 마감이 다르면 수정 제안만 기록한다.
export async function syncCandidates(
  candidates: Candidate[],
  source: Source,
  deps: LedgerDeps,
): Promise<SyncResult> {
  const result: SyncResult = { created: [], skipped: [], proposed: [], failed: [], warnings: [] };
  if (candidates.length === 0) return result;

  let existing: LedgerTask[];
  try {
    existing = await deps.veloo.listTasks();
  } catch (e) {
    for (const candidate of candidates) result.failed.push({ candidate, error: errorText(e) });
    return result;
  }

  // 비서가 만든 태스크인지는 메모의 표식이 아니라 처리 기록의 태스크 번호로 안다(예전 표식이 있는 태스크도 인정한다).
  const assistantIds = await loadAssistantTaskIds(deps.store);
  const madeByAssistant = (t: LedgerTask) => assistantIds.has(t.id) || isAssistantTask(t);

  for (const [index, candidate] of candidates.entries()) {
    const key = `${source.id}#${index}`;
    try {
      if (await deps.store.has(source.kind, key)) {
        result.skipped.push({ candidate, reason: 'already-processed' });
        continue;
      }

      const match = existing.find(
        (t) => !t.done && !madeByAssistant(t) && sameName(t.name, candidate.name),
      );
      if (match) {
        if (candidate.deadline && candidate.deadline !== match.deadline) {
          await deps.store.record('proposal', `${source.kind}:${key}`, {
            action: 'update_task',
            taskId: match.id,
            name: match.name,
            currentDeadline: match.deadline,
            proposedDeadline: candidate.deadline,
          });
          result.proposed.push({ candidate, existing: match });
        } else {
          result.skipped.push({ candidate, reason: 'exists' });
        }
        await deps.store.record(source.kind, key, { matchedTaskId: match.id });
        continue;
      }

      // 단축어가 오류를 보여서 같은 입력을 다시 보내는 경우를 막는다:
      // 비서가 이미 만든 미완료 태스크와 이름과 마감이 모두 같으면 새로 만들지 않는다.
      const repeat = existing.find(
        (t) => !t.done && madeByAssistant(t) && t.deadline === candidate.deadline && sameName(t.name, candidate.name),
      );
      if (repeat) {
        result.skipped.push({ candidate, reason: 'exists' });
        await deps.store.record(source.kind, key, { matchedTaskId: repeat.id });
        continue;
      }

      // 메모에는 내용(시각 등)만 쓴다. 내부 표식은 넣지 않는다.
      const task = await deps.veloo.createTask(candidate);
      assistantIds.add(task.id);
      result.created.push({ candidate, task });
      try {
        await deps.store.record(source.kind, key, { taskId: task.id, name: candidate.name, deadline: candidate.deadline });
      } catch (e) {
        result.warnings.push(`${candidate.name}: 태스크는 만들었지만 처리 이력을 저장하지 못함(${errorText(e)})`);
      }
    } catch (e) {
      result.failed.push({ candidate, error: errorText(e) });
    }
  }
  return result;
}
