import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Camera, X } from 'lucide-react';
import { useGraph, entitiesOfType } from '../core/entityGraph';
import { str } from '../core/answer';

interface SerialCaptureProps {
  onSerial: (serial: string) => void;
  onClose: () => void;
}

/**
 * Field mode: read a serial from a nameplate photo.
 * The capture is mocked (it "reads" a serial from your records); the input
 * that receives it is real, so a tech can correct a misread digit before
 * asking. Swap the mock read for the /api/extract call when the camera is wired.
 */
export function SerialCapture({ onSerial, onClose }: SerialCaptureProps) {
  const graph = useGraph();
  const [serial, setSerial] = useState('');
  const [reading, setReading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const capture = () => {
    setReading(true);
    const units = entitiesOfType(graph, 'equipment');
    const pick = units[Math.floor(Math.random() * units.length)];
    window.setTimeout(() => {
      setSerial(pick ? str(pick, 'serial') : '');
      setReading(false);
      inputRef.current?.focus();
    }, 600);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (serial.trim()) onSerial(serial.trim().toUpperCase());
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-stone-950/50 cursor-default" tabIndex={-1} />
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="capture-title" className="relative w-full sm:max-w-md bg-surface text-ink rounded-t-xl sm:rounded-xl shadow-modal p-5 space-y-4 animate-rise">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="dw-label">Serial from photo</p>
            <h2 id="capture-title" className="font-sans font-semibold text-h3">
              Point at the nameplate
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="dw-btn-tertiary -mr-2 min-w-touch">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <button
          type="button"
          onClick={capture}
          disabled={reading}
          className="w-full aspect-[4/3] rounded-lg border-2 border-dashed border-line-2 bg-bg grid place-items-center text-ink-3 hover:border-forest-700 dark:hover:border-brass-300 transition-colors duration-quick"
          aria-label="Capture serial from nameplate (simulated)"
        >
          <span className="flex flex-col items-center gap-2">
            <Camera className={`w-8 h-8 ${reading ? 'animate-pulse' : ''}`} aria-hidden="true" />
            <span className="text-body">{reading ? 'Reading…' : 'Tap to capture (simulated)'}</span>
          </span>
        </button>

        <div className="space-y-2">
          <label htmlFor="serial-input" className="dw-label">
            Serial number
          </label>
          <input
            ref={inputRef}
            id="serial-input"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="SN-XXX-000000"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="dw-input font-mono text-body-xl tracking-wider"
          />
          <p className="text-caption text-ink-3">Check the digits against the plate before asking.</p>
        </div>

        <div className="flex gap-2 justify-end">
          <button type="button" className="dw-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dw-btn-primary" disabled={!serial.trim()}>
            Ask about this serial
          </button>
        </div>
      </form>
    </div>
  );
}
