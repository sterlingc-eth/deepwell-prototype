import { AlertCircle, CheckCircle, HelpCircle, XCircle } from 'lucide-react';
import type { Equipment } from '../types';

export type WarrantyStatus = 'active' | 'expiring' | 'expired' | 'unknown';

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

interface WarrantyStatusBadgeProps {
  warranty: Pick<Equipment, 'warrantyExpiry'>;
  /** Show the text label next to the icon (default true — colour alone is never the signal). */
  showLabel?: boolean;
}

export function WarrantyStatusBadge({ warranty, showLabel = true }: WarrantyStatusBadgeProps) {
  const info = warrantyStatus(warranty.warrantyExpiry);
  const { className, Icon } = PILL[info.status];
  return (
    <span className={className} role="status" aria-label={`Warranty: ${info.label}`}>
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {showLabel && <span>{info.label}</span>}
    </span>
  );
}
