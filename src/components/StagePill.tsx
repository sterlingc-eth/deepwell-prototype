import { CheckCircle2, Link2, FileSearch, Tags, Inbox, Sparkles } from 'lucide-react';
import type { PipelineStage } from '../core/types';

// Display labels only — the underlying PipelineStage values (received,
// classified, extracted, linked, verified) are unchanged everywhere else
// (API payloads, entityGraph.ts, types.ts). A shop owner has never
// "classified" anything; these are the plain-language equivalents.
export const STAGE_LABEL: Record<PipelineStage, string> = {
  received: 'Uploaded',
  classified: 'Sorted',
  extracted: 'Read',
  linked: 'Matched',
  verified: 'Checked',
};

/** Stage name as shown. A company file is never matched to a customer, so its Matched step reads "Not needed"
 *  (the stored stage value is unchanged). */
export function stageLabel(stage: PipelineStage, companyFile = false): string {
  return companyFile && stage === 'linked' ? 'Not needed' : STAGE_LABEL[stage];
}

const STAGE_STYLE: Record<PipelineStage, { className: string; Icon: typeof CheckCircle2 }> = {
  received: { className: 'dw-pill-muted', Icon: Inbox },
  classified: { className: 'dw-pill-muted', Icon: Tags },
  extracted: { className: 'dw-pill-info', Icon: FileSearch },
  linked: { className: 'dw-pill-warn', Icon: Link2 },
  verified: { className: 'dw-pill-ok', Icon: CheckCircle2 },
};

/** `ai`: this document's stage was reached by an AI verification
 *  (`verifiedBy === 'ai'`), not a person — see the team brief's AI
 *  VERIFICATION CONTRACT. Only changes rendering when `stage === 'verified'`. */
export function StagePill({ stage, compact = false, ai = false, companyFile = false }: { stage: PipelineStage; compact?: boolean; ai?: boolean; companyFile?: boolean }) {
  const aiVerified = ai && stage === 'verified';
  const skipped = companyFile && stage === 'linked';
  const { className, Icon } = aiVerified ? { className: 'dw-pill-ok', Icon: Sparkles } : skipped ? { className: 'dw-pill-muted', Icon: Link2 } : STAGE_STYLE[stage];
  const label = aiVerified ? 'AI verified' : stageLabel(stage, companyFile);
  return (
    <span className={className} aria-label={`Stage: ${label}`}>
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {!compact && label}
    </span>
  );
}
