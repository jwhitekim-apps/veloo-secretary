import type { Candidate, Source, SyncResult } from '../domain/ledger.js';
import { describeTask, readBackText } from '../domain/interpret.js';
import type { InterpretResult } from '../domain/interpret.js';

export type IntakeFlowDeps = {
  interpret: (input: unknown) => Promise<InterpretResult>;
  sync: (candidates: Candidate[], source: Source) => Promise<SyncResult>;
  store: { record(kind: string, id: string, data: unknown): Promise<boolean> };
  newId: () => string;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 단축어로 들어온 입력 하나를 처리한다: 해석 → 벨루 저장 → 한 문장 응답.
// 입력마다 새 출처 ID를 쓰므로 같은 문장을 다시 보내면 새 태스크가 된다(재시도 중복은 감수).
export async function processIntake(
  input: unknown,
  deps: IntakeFlowDeps,
  options: { dryRun?: boolean } = {},
): Promise<{ message: string } | { error: string }> {
  const interpreted = await deps.interpret(input);
  if ('error' in interpreted) return interpreted;
  if (interpreted.tasks.length === 0) return { message: interpreted.message };
  // 시험 모드: 해석 결과만 보여 주고 벨루에도 처리 이력에도 쓰지 않는다.
  if (options.dryRun) return { message: `[시험: 저장 안 함] ${interpreted.message}` };

  const id = deps.newId();
  const synced = await deps.sync(interpreted.tasks, { kind: 'intake', id });

  const parts: string[] = [];
  const names = (items: { candidate: Candidate }[]) => items.map((i) => describeTask(i.candidate)).join(' / ');

  if (synced.created.length) parts.push(`추가했어요 ${synced.created.length}건: ${names(synced.created)}.`);
  if (synced.proposed.length) {
    parts.push(`비슷한 일정이 이미 있어서 수정은 제안으로만 남겼어요: ${names(synced.proposed)}.`);
  }
  const exists = synced.skipped.filter((s) => s.reason === 'exists');
  if (exists.length) parts.push(`이미 있는 일정: ${names(exists)}.`);

  if (synced.failed.length) {
    for (const [i, f] of synced.failed.entries()) {
      await deps
        .store.record('failure', `intake-${id}-${i}`, { message: `입력 저장 실패: ${f.candidate.name} (${f.error})` })
        .catch(() => false);
    }
    parts.push(`벨루에 저장하지 못했어요(${errorText(synced.failed[0].error)}): ${names(synced.failed)}. 직접 추가해 주세요.`);
  }

  if (interpreted.assumptions.length) parts.push(`추정: ${interpreted.assumptions.join('; ')}.`);
  if (interpreted.unreadable.length) parts.push(`읽을 수 없음: ${interpreted.unreadable.join('; ')}.`);
  return { message: parts.join(' ') + readBackText(interpreted.transcript) };
}
