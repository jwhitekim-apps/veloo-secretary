export type Tier = 'free' | 'notify' | 'confirm' | 'forbidden';

// 행동별 위임 단계. docs/delegation.md와 같은 내용이어야 하며 테스트가 대조한다.
export const ACTION_TIERS: Readonly<Record<string, Tier>> = {
  read_tasks: 'free',
  search_mail: 'free',
  read_mail_body: 'free',
  create_task: 'notify',
  update_task: 'confirm',
  delete_task: 'confirm',
  send_mail: 'forbidden',
  submit_external: 'forbidden',
  make_payment: 'forbidden',
};

export type ToolFn = (input: unknown) => Promise<unknown>;
export type Proposal = { action: string; input: unknown };
export type RecordProposal = (proposal: Proposal) => Promise<void>;

// 모델에 노출할 도구 모음을 만든다.
// - free/notify 단계만 실제 구현을 받는다. 그 밖의 단계나 분류되지 않은 이름은 거부한다.
// - confirm 단계는 실제 구현 없이 "제안 기록" 도구로만 노출한다.
// - forbidden 단계는 어떤 경로로도 노출하지 않는다.
export function buildToolset(
  impls: Record<string, ToolFn>,
  recordProposal: RecordProposal,
): Record<string, ToolFn> {
  const toolset: Record<string, ToolFn> = {};

  for (const [name, fn] of Object.entries(impls)) {
    const tier = ACTION_TIERS[name];
    if (tier !== 'free' && tier !== 'notify') {
      const reason = tier ? `tier is ${tier}` : 'not classified in ACTION_TIERS';
      throw new Error(`Tool "${name}" cannot be exposed: ${reason}`);
    }
    toolset[name] = fn;
  }

  for (const [name, tier] of Object.entries(ACTION_TIERS)) {
    if (tier === 'confirm') {
      toolset[name] = async (input) => {
        await recordProposal({ action: name, input });
        return { status: 'proposed' };
      };
    }
  }

  return toolset;
}
