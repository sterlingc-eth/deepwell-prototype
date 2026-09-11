// @ts-nocheck
import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, CheckCircle, AlertCircle, XCircle } from 'lucide-react';
import type { Equipment } from '../types';
import { WarrantyStatusBadge } from './WarrantyStatusBadge';
import { DataField } from './DataField';

interface EquipmentCardProps {
  equipment: Equipment;
  isSelected?: boolean;
  onSelect?: (equipment: Equipment) => void;
  expandable?: boolean;
  compact?: boolean;
  showFullHistory?: boolean;
}

export const EquipmentCard: React.FC<EquipmentCardProps> = ({
  equipment,
  isSelected = false,
  onSelect,
  expandable = true,
  compact = false,
  showFullHistory = false,
}) => {
  const [isExpanded, setIsExpanded] = useState(showFullHistory);

  const warrantyStatus = equipment.warrantyExpiry
    ? new Date() > equipment.warrantyExpiry
      ? 'expired'
      : new Date().getTime() + 30 * 24 * 60 * 60 * 1000 > equipment.warrantyExpiry.getTime()
        ? 'expiring'
        : 'active'
    : 'none';

  const daysUntilExpiry =
    equipment.warrantyExpiry && warrantyStatus !== 'expired'
      ? Math.ceil((equipment.warrantyExpiry.getTime() - new Date().getTime()) / (24 * 60 * 60 * 1000))
      : null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className={`
        border border-accent-700 dark:border-accent-600 rounded-lg
        bg-accent-900 dark:bg-accent-800
        overflow-hidden
        cursor-pointer
        transition-all
        ${isSelected ? 'ring-2 ring-primary-500' : 'hover:ring-1 hover:ring-accent-600'}
        ${compact ? 'p-3' : 'p-4'}
      `}
      onClick={() => onSelect?.(equipment)}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          {/* Serial Number - Hero Element */}
          <div className="font-mono text-sm font-bold text-primary-400 mb-2 truncate">
            {equipment.serialNumber}
          </div>

          {/* Equipment Info */}
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-semibold text-primary-300 bg-primary-900 px-2 py-1 rounded">
              {equipment.manufacturer}
            </span>
            <span className="text-xs text-accent-400">{equipment.modelNumber}</span>
            <span className="text-xs text-accent-500">{equipment.equipmentType}</span>
          </div>

          {/* Warranty Badge */}
          {!compact && <WarrantyStatusBadge warranty={equipment} showLabel />}
        </div>

        {/* Selection Checkbox */}
        {onSelect && (
          <div className="flex-shrink-0 pt-1">
            {isSelected ? (
              <CheckCircle className="w-5 h-5 text-primary-500" />
            ) : (
              <div className="w-5 h-5 border-2 border-accent-600 rounded-full" />
            )}
          </div>
        )}
      </div>

      {/* Expand/Collapse Section */}
      {expandable && (
        <motion.div
          initial={false}
          animate={{ height: isExpanded ? 'auto' : 0, opacity: isExpanded ? 1 : 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden mt-3 pt-3 border-t border-accent-700 dark:border-accent-600"
        >
          <div className="space-y-2 text-sm">
            <DataField
              label="Installed"
              value={equipment.installDate.toLocaleDateString()}
              monospace={false}
            />
            <DataField label="Installed By" value={equipment.installedByTechName} />
            {equipment.epaCertType && (
              <DataField label="EPA Cert" value={equipment.epaCertType} />
            )}
            {warrantyStatus !== 'none' && daysUntilExpiry !== null && (
              <DataField
                label="Warranty Expires"
                value={`${daysUntilExpiry} days (${equipment.warrantyExpiry?.toLocaleDateString()})`}
                highlight={warrantyStatus !== 'active'}
              />
            )}
            {equipment.status !== 'active' && (
              <DataField label="Status" value={equipment.status} highlight />
            )}
          </div>
        </motion.div>
      )}

      {/* Toggle Button */}
      {expandable && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded(!isExpanded);
          }}
          className="mt-3 w-full flex items-center justify-center gap-2 text-xs text-primary-400 hover:text-primary-300 transition"
        >
          {isExpanded ? 'Hide Details' : 'Show Details'}
          <ChevronDown
            className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    </motion.div>
  );
};
