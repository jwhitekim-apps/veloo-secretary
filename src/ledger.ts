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
  };
};

export type SyncResult = {
  created: { candidate: Candidate; task: LedgerTask }[];
  skipped: { candidate: Candidate; reason: 'already-processed' | 'exists' }[];
  proposed: { candidate: Candidate; existing: LedgerTask }[];
  failed: { candidate: Candidate; error: string }[];
  warnings: string[];
};

export const MARKER_PREFIX = '[비서:';

export function isAssistantTask(task: { memo: string }): boolean {
  return task.memo.includes(MARKER_PREFIX);
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

  for (const [index, candidate] of candidates.entries()) {
    const key = `${source.id}#${index}`;
    try {
      // 처리 이력이 없어도(저장소가 없거나 비어 있어도) 벨루에 같은 출처 표식의 태스크가 이미 있으면 다시 만들지 않는다.
      const marker = `${MARKER_PREFIX}${source.kind}:${key}]`;
      if ((await deps.store.has(source.kind, key)) || existing.some((t) => t.memo.includes(marker))) {
        result.skipped.push({ candidate, reason: 'already-processed' });
        continue;
      }

      const match = existing.find(
        (t) => !t.done && !isAssistantTask(t) && sameName(t.name, candidate.name),
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

      const memo = [candidate.memo, marker].filter(Boolean).join('\n');
      const task = await deps.veloo.createTask({ ...candidate, memo });
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
