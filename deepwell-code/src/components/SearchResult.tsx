// @ts-nocheck
import React from 'react';
import { motion } from 'framer-motion';
import { Wrench, MapPin, Clock } from 'lucide-react';
import type { SearchResult as SearchResultType } from '../types';
import { EquipmentCard } from './EquipmentCard';

interface SearchResultProps {
  result: SearchResultType;
  index: number;
  isHighlighted?: boolean;
  onSelect?: (result: SearchResultType) => void;
}

export const SearchResult: React.FC<SearchResultProps> = ({
  result,
  index,
  isHighlighted = false,
  onSelect,
}) => {
  const getIcon = () => {
    switch (result.type) {
      case 'equipment':
        return <Wrench className="w-4 h-4" />;
      case 'property':
        return <MapPin className="w-4 h-4" />;
      case 'service_event':
        return <Clock className="w-4 h-4" />;
    }
  };

  const getTypeLabel = () => {
    switch (result.type) {
      case 'equipment':
        return 'Equipment';
      case 'property':
        return 'Property';
      case 'service_event':
        return 'Service';
    }
  };

  const getDescription = () => {
    if (result.type === 'equipment') {
      const eq = result.data as any;
      return `${eq.manufacturer} ${eq.modelNumber} · ${eq.equipmentType}`;
    }
    if (result.type === 'property') {
      const prop = result.data as any;
      return `${prop.address}, ${prop.city}, ${prop.state}`;
    }
    if (result.type === 'service_event') {
      const svc = result.data as any;
      return `${svc.workPerformed} · $${svc.cost}`;
    }
    return '';
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: index * 0.08,
        duration: 0.4,
        ease: 'easeOut',
      }}
      className={`
        cursor-pointer
        transition-all
        ${isHighlighted ? 'ring-2 ring-primary-500' : ''}
      `}
      onClick={() => onSelect?.(result)}
    >
      {result.type === 'equipment' ? (
        <EquipmentCard
          equipment={result.data}
          onSelect={() => onSelect?.(result)}
          expandable={false}
          compact
        />
      ) : (
        <div
          className={`
            border border-accent-700 dark:border-accent-600 rounded-lg
            bg-accent-900 dark:bg-accent-800
            p-4
            hover:bg-accent-800 dark:hover:bg-accent-700
            transition-colors
          `}
        >
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 pt-1 text-primary-400">{getIcon()}</div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold text-primary-300 mb-1">
                {getTypeLabel()}
              </div>
              <div className="text-sm text-accent-300 mb-2 truncate">
                {getDescription()}
              </div>
              <div className="text-xs text-accent-500">
                {result.matchReason}
              </div>
            </div>
            <div className="flex-shrink-0 flex flex-col items-end gap-1">
              <div className="text-xs font-mono text-primary-400">
                {Math.round(result.matchScore)}%
              </div>
              <div className="text-xs text-accent-500">{result.confidence}%</div>
            </div>
          </div>

          {/* Match score bar */}
          <div className="mt-2 h-1 bg-accent-800 rounded-full overflow-hidden">
            <motion.div
              initial={{ width: 0 }}
              animate={{ width: `${result.matchScore}%` }}
              transition={{ delay: 0.2 + index * 0.08, duration: 0.6 }}
              className="h-full bg-gradient-to-r from-primary-500 to-secondary-500"
            />
          </div>

          {/* Confidence indicator */}
          <div className="mt-2 text-xs">
            <div className="flex items-center justify-between text-accent-500 mb-1">
              <span>Extraction Confidence</span>
              <span className="font-mono">{result.confidence}%</span>
            </div>
            <div className="h-1 bg-accent-800 rounded-full overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: `${result.confidence}%` }}
                transition={{ delay: 0.3 + index * 0.08, duration: 0.6 }}
                className={`h-full ${
                  result.confidence >= 90
                    ? 'bg-success'
                    : result.confidence >= 80
                      ? 'bg-secondary-500'
                      : 'bg-warning'
                }`}
              />
            </div>
          </div>
        </div>
      )}
    </motion.div>
  );
};
