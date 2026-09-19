import { CheckCircle2, Link2, FileSearch, Tags, Inbox, Sparkles } from 'lucide-react';
import type { PipelineStage } from '../core/types';

export const STAGE_LABEL: Record<PipelineStage, string> = {
  received: 'Received',
  classified: 'Classified',
  extracted: 'Extracted',
  linked: 'Linked',
  verified: 'Verified',
};

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
export function StagePill({ stage, compact = false, ai = false }: { stage: PipelineStage; compact?: boolean; ai?: boolean }) {
  const aiVerified = ai && stage === 'verified';
  const { className, Icon } = aiVerified ? { className: 'dw-pill-ok', Icon: Sparkles } : STAGE_STYLE[stage];
  const label = aiVerified ? 'AI verified' : STAGE_LABEL[stage];
  return (
    <span className={className} aria-label={`Stage: ${label}`}>
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {!compact && label}
    </span>
  );
}
