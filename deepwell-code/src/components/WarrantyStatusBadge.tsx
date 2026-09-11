import React from 'react';
import { AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import type { Equipment } from '../types';

interface WarrantyStatusBadgeProps {
  warranty: Equipment;
  showLabel?: boolean;
}

export const WarrantyStatusBadge: React.FC<WarrantyStatusBadgeProps> = ({
  warranty,
  showLabel = false,
}) => {
  if (!warranty.warrantyExpiry) {
    return (
      <div className="flex items-center gap-2 inline-flex">
        <div className="w-3 h-3 rounded-full bg-accent-500" />
        <span className="text-xs text-accent-400">No Warranty Data</span>
      </div>
    );
  }

  const now = new Date();
  const expiryDate = warranty.warrantyExpiry;
  const daysUntilExpiry = Math.ceil(
    (expiryDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
  );

  let status: 'active' | 'expiring' | 'expired';
  let bgColor: string;
  let textColor: string;
  let icon: React.ReactNode;
  let label: string;

  if (daysUntilExpiry < 0) {
    status = 'expired';
    bgColor = 'bg-red-900/30';
    textColor = 'text-error';
    icon = <XCircle className="w-4 h-4" />;
    label = 'Expired';
  } else if (daysUntilExpiry < 30) {
    status = 'expiring';
    bgColor = 'bg-secondary-900/30';
    textColor = 'text-secondary-400';
    icon = <AlertCircle className="w-4 h-4" />;
    label = `Expiring (${daysUntilExpiry}d)`;
  } else {
    status = 'active';
    bgColor = 'bg-success/10';
    textColor = 'text-success';
    icon = <CheckCircle className="w-4 h-4" />;
    label = 'Active';
  }

  return (
    <div
      className={`
        inline-flex items-center gap-2 px-2 py-1 rounded-md
        ${bgColor} ${textColor}
        text-xs font-medium
      `}
      role="status"
      aria-label={`Warranty status: ${label}`}
    >
      {icon}
      {showLabel && <span>{label}</span>}
    </div>
  );
};
