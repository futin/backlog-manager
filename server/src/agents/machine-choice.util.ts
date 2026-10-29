import { DEFAULT_MODEL, projectDispatchGate } from '../../../shared/agent';
import type { AgentsStatus } from '../../../shared/types';
import type { Machine } from './dashboards/dashboards.service';

/*
 * machine-choice.util.ts — the remote-launch checks against a `Machine`'s own lists and a remote dashboard's gate (multi-dashboard task 5):
 * `machineChoiceBlock` (a model or effort outside the machine's list), `remoteDefaultModel` (the model a launch with no pick runs on there) and
 * `remoteGateBlock` (`projectDispatchGate` asked about the project's path on that machine). `AgentsService` calls all three, for a dispatch and an
 * orchestrate alike.
 *
 * Moved out of `agents.service.ts` in #388 (#351): pure functions of their arguments, so a util rather than more of the service file, which exports its
 * class and its request types and nothing else (`test/server-layering.test.ts`).
 */

/**
 * A remote launch's model/effort refusal (multi-dashboard task 5), `null` to proceed. On a REMOTE machine any value outside that machine's list is a 400,
 * unknown names included: the remote dashboard drops a name outside its own fixed list without a word, and a name inside that list but outside what the
 * account can run would start a session that fails — either way nobody would hear about it (spec, "Models and efforts are per machine"). `undefined` and
 * `''` are "no pick" — the two spellings `pickFrom` documents as the sheet's Default — and are not refused. Never called for home, whose `pickFrom` drop
 * is unchanged. Exported for `orchestrate`'s remote launch to share one wording with this one.
 */
export function machineChoiceBlock(m: Machine, model: unknown, effort: unknown): string | null {
  const outside = (value: unknown, list: readonly string[]): boolean =>
    value !== undefined && value !== '' && !(typeof value === 'string' && list.includes(value));
  if (outside(model, m.models)) return `model "${String(model)}" is not in ${m.label}'s list (${m.models.join(', ')})`;
  if (outside(effort, m.efforts)) return `effort "${String(effort)}" is not in ${m.label}'s list (${m.efforts.join(', ')})`;
  return null;
}

/**
 * The model a remote launch with no pick runs on: `DEFAULT_MODEL`, as home's does, when the machine lists it — otherwise the machine's first listed model,
 * because sending `DEFAULT_MODEL` to an account whose list leaves it out is exactly the silent failure the list exists to prevent. Never `undefined`: home
 * never sends a spawn without a model either (`DEFAULT_MODEL`'s own comment), and a remote must not fall to the CLI's own default instead.
 */
export function remoteDefaultModel(m: Machine): string {
  return m.models.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : (m.models[0] ?? DEFAULT_MODEL);
}

/** `dispatchBlock`'s flattening of the gate, for a remote: the same `projectDispatchGate`, asked about the project's path on THAT machine. */
export function remoteGateBlock(status: AgentsStatus, remotePath: string): string | null {
  const gate = projectDispatchGate(status, remotePath);
  return gate.control === 'enabled' ? null : gate.reason;
}
