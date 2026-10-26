import type { OrchestrateDraft } from '../../../hooks/useOrchestrateDraft';

/** The one props shape all three Orchestrate step views take (#306): the draft, and nothing of their own. */
export interface StepProps {
  draft: OrchestrateDraft;
}
