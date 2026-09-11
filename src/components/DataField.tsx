import React from 'react';

interface DataFieldProps {
  label: string;
  value: string | React.ReactNode;
  monospace?: boolean;
  icon?: React.ReactNode;
  highlight?: boolean;
}

export const DataField: React.FC<DataFieldProps> = ({
  label,
  value,
  monospace = false,
  icon,
  highlight = false,
}) => {
  return (
    <div className="flex items-start justify-between gap-3">
      <label className="text-xs font-medium text-accent-400 flex-shrink-0 flex items-center gap-1">
        {icon}
        {label}
      </label>
      <div
        className={`
          text-xs text-right flex-1
          ${monospace ? 'font-mono' : 'font-normal'}
          ${highlight ? 'text-secondary-400 font-semibold' : 'text-accent-300'}
        `}
      >
        {value}
      </div>
    </div>
  );
};
