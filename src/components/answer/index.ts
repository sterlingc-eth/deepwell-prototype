// Shared answer-presentation pieces (round 12) — used by both the desktop AnswerCard and the mobile
// MobileAnswer so the two surfaces render the same layout logic (src/core/answerLayout.ts) with the
// same components, not two parallel implementations.
export { humanDate, relativeNote, humanDateWithRelative } from './dates';
export { SourceChip } from './SourceChip';
export { CopyValueButton } from './CopyValueButton';
export { FollowupChips } from './FollowupChips';
export { ShareButton } from './ShareButton';
export { MoneyHero } from './MoneyHero';
export { StatusHero } from './StatusHero';
export { SingleFactHero } from './SingleFactHero';
export { TimelineList } from './TimelineList';
export { NotOnFileBadge } from './NotOnFileBadge';
