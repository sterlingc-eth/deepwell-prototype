// @ts-nocheck
import React from 'react';
import { motion } from 'framer-motion';
import { Clock } from 'lucide-react';
import type { ServiceEvent, Equipment } from '../types';
import { serviceEvents } from '../mocks/data';
import { DataField } from './DataField';

interface ServiceHistoryTimelineProps {
  equipment: Equipment;
  compact?: boolean;
}

export const ServiceHistoryTimeline: React.FC<ServiceHistoryTimelineProps> = ({
  equipment,
  compact = false,
}) => {
  if (!equipment) {
    return <div className="text-xs text-accent-500 italic">Equipment not available</div>;
  }

  const events = serviceEvents
    .filter((svc) => svc.equipmentId === equipment.id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (events.length === 0) {
    return (
      <div className="text-xs text-accent-500 italic">No service history recorded</div>
    );
  }

  return (
    <div className="space-y-4">
      {events.map((event, index) => (
        <motion.div
          key={event.id}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: index * 0.05 }}
          className="relative pl-6"
        >
          {/* Timeline dot */}
          <div className="absolute left-0 top-1 w-3 h-3 rounded-full bg-primary-500" />

          {/* Timeline connector */}
          {index < events.length - 1 && (
            <div className="absolute left-1 top-4 w-0.5 h-12 bg-accent-700 dark:bg-accent-600" />
          )}

          {/* Event card */}
          <div className="bg-accent-900 dark:bg-accent-800 border border-accent-700 dark:border-accent-600 rounded p-3">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary-400" />
                <span className="font-semibold text-xs text-primary-300">
                  {event.date.toLocaleDateString()}
                </span>
              </div>
              <span className="text-xs font-mono text-secondary-400">${event.cost}</span>
            </div>

            {!compact && (
              <>
                <div className="text-xs text-accent-300 mb-2">{event.workPerformed}</div>
                <div className="space-y-1">
                  <DataField label="Technician" value={event.technicianName} />
                  {event.notes && (
                    <div className="text-xs text-accent-400 italic mt-1 p-2 bg-accent-800 rounded border-l-2 border-primary-500">
                      {event.notes}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </motion.div>
      ))}
    </div>
  );
};
