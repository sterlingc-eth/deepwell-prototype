import { CheckCircle2, Link2, FileSearch, Tags, Inbox } from 'lucide-react';
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

export function StagePill({ stage, compact = false }: { stage: PipelineStage; compact?: boolean }) {
  const { className, Icon } = STAGE_STYLE[stage];
  return (
    <span className={className} aria-label={`Stage: ${STAGE_LABEL[stage]}`}>
      <Icon className="w-3.5 h-3.5 dark:w-4 dark:h-4 shrink-0" aria-hidden="true" />
      {!compact && STAGE_LABEL[stage]}
    </span>
  );
}
