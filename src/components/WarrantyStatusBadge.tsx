import { AlertCircle, CheckCircle, Clock, HelpCircle, XCircle } from 'lucide-react';
import type { Equipment } from '../types';

export type WarrantyStatus = 'active' | 'expiring' | 'expired' | 'unknown';

/** The richer tiers `api/_lib/warrantyRules.js`'s `alertTier` computes from a
 *  full derivation (registration deadlines included), not just a bare date —
 *  see the Alerts section on DashboardScreen. */
export type AlertTier =
  | 'expired'
  | 'expiring-30'
  | 'expiring-90'
  | 'expiring-365'
  | 'unregistered-window-closing'
  | 'ok'
  | 'unknown';

export interface WarrantyStatusInfo {
  status: WarrantyStatus;
  label: string;
  daysRemaining: number | null;
}

const DAY = 24 * 60 * 60 * 1000;

/** Single source of truth for how a warranty date becomes a status. */
export function warrantyStatus(expiry: Date | null | undefined, now: Date = new Date()): WarrantyStatusInfo {
  if (!expiry) return { status: 'unknown', label: 'No warranty on file', daysRemaining: null };
  const days = Math.ceil((expiry.getTime() - now.getTime()) / DAY);
  if (days < 0) return { status: 'expired', label: `Expired ${Math.abs(days)}d ago`, daysRemaining: days };
  if (days <= 90) return { status: 'expiring', label: `Expires in ${days}d`, daysRemaining: days };
  return { status: 'active', label: 'Active', daysRemaining: days };
}

const PILL: Record<WarrantyStatus, { className: string; Icon: typeof CheckCircle }> = {
  active: { className: 'dw-pill-ok', Icon: CheckCircle },
  expiring: { className: 'dw-pill-warn', Icon: AlertCircle },
  expired: { className: 'dw-pill-bad', Icon: XCircle },
  unknown: { className: 'dw-pill-muted', Icon: HelpCircle },
};

/** Tier-aware styling, reusing the same five pill classes as everywhere else
 *  in the app (no new colors invented). `expiring-30` shares `expired`'s red
 *  because both need same-week attention; `unregistered-window-closing` gets
 *  the amber "needs action" treatment, same as `expiring-90`, since missing
 *  it is an action failure rather than a coverage failure (yet). */
const TIER_PILL: Record<AlertTier, { className: string; Icon: typeof CheckCircle; label: string }> = {
  expired: { className: 'dw-pill-bad', Icon: XCircle, label: 'Expired' },
  'expiring-30': { className: 'dw-pill-bad', Icon: AlertCircle, label: 'Expires within 30 days' },
  'expiring-90': { className: 'dw-pill-warn', Icon: AlertCircle, label: 'Expires within 90 days' },
  'expiring-365': { className: 'dw-pill-info', Icon: Clock, label: 'Expires within 12 months' },
  'unregistered-window-closing': { className: 'dw-pill-warn', Icon: Clock, label: 'Registration window closing' },
  ok: { className: 'dw-pill-ok', Icon: CheckCircle, label: 'Active' },
  unknown: { className: 'dw-pill-muted', Icon: HelpCircle, label: 'No warranty on file' },
};

interface WarrantyStatusBadgeProps {
  warranty: Pick<Equipment, 'warrantyExpiry'>;
  /** Show the text label next to the icon (default true — colour alone is never the signal). */
  showLabel?: boolean;
  /** When given, overrides the plain days-based status with the richer alert
   *  tier from POST /api/warranty-attention (registration deadlines, fixed
   *  30/90/365 buckets) — `warranty` is then ignored. */
  tier?: AlertTier;
}

export function WarrantyStatusBadge({ warranty, showLabel = true, tier }: WarrantyStatusBadgeProps) {
  if (tier) {
    const { className, Icon, label } = TIER_PILL[tier];
    return (
      <span className={className} role="status" aria-label={`Warranty: ${label}`}>
        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
        {showLabel && <span>{label}</span>}
      </span>
    );
  }
  const info = warrantyStatus(warranty.warrantyExpiry);
  const { className, Icon } = PILL[info.status];
  return (
    <span className={className} role="status" aria-label={`Warranty: ${info.label}`}>
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {showLabel && <span>{info.label}</span>}
    </span>
  );
}
