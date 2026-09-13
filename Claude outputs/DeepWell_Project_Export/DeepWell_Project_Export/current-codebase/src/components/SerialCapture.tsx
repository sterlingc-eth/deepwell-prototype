import { useRef, useState, type FormEvent } from 'react';
import { Camera, X } from 'lucide-react';
import { useGraph, entitiesOfType } from '../core/entityGraph';
import { str } from '../core/answer';
import { useFocusTrap } from './useFocusTrap';

interface SerialCaptureProps {
  onSerial: (serial: string) => void;
  onClose: () => void;
}

/**
 * Field mode: read a serial from a nameplate photo.
 * Until the camera is wired, the "read" is a stand-in that picks a serial
 * from the loaded records; the input that receives it is real, so a tech can
 * correct a misread digit before asking. Swap `capture` for the /api/extract
 * call when the camera lands. The UI never claims more than it does.
 *
 * Focus is trapped in the dialog (initial focus on the capture button),
 * Escape closes, and focus returns to the opener on close.
 */
export function SerialCapture({ onSerial, onClose }: SerialCaptureProps) {
  const graph = useGraph();
  const [serial, setSerial] = useState('');
  const [reading, setReading] = useState(false);
  const [hasRead, setHasRead] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const captureRef = useRef<HTMLButtonElement>(null);

  useFocusTrap(true, formRef, { initialFocus: captureRef, onEscape: onClose });

  const capture = () => {
    setReading(true);
    const units = entitiesOfType(graph, 'equipment');
    const pick = units[Math.floor(Math.random() * units.length)];
    window.setTimeout(() => {
      setSerial(pick ? str(pick, 'serial') : '');
      setReading(false);
      setHasRead(true);
      inputRef.current?.focus();
    }, 600);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (serial.trim()) onSerial(serial.trim().toUpperCase());
  };

  const captureLabel = reading ? 'Reading…' : hasRead ? 'Read again' : 'Tap to read the nameplate';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-stone-950/50 cursor-default" tabIndex={-1} />
      <form
        ref={formRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby="capture-title"
        className="relative w-full sm:max-w-md flex flex-col bg-surface text-ink rounded-t-xl sm:rounded-xl shadow-modal p-5 space-y-4 animate-rise"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="dw-label">Serial from photo</p>
            <h2 id="capture-title" className="font-sans font-semibold text-h3">
              Point at the nameplate
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="dw-btn-tertiary -mr-2 min-w-touch min-h-touch shrink-0">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <button
          ref={captureRef}
          type="button"
          onClick={capture}
          disabled={reading}
          aria-busy={reading}
          className="w-full aspect-[4/3] min-h-touch rounded-lg border-2 border-dashed border-line-2 bg-bg grid place-items-center text-ink-3 hover:border-forest-700 dark:hover:border-brass-300 transition-colors duration-quick motion-reduce:transition-none"
          aria-label="Read serial from nameplate"
        >
          <span className="flex flex-col items-center gap-2">
            <Camera className={`w-8 h-8 ${reading ? 'animate-pulse motion-reduce:animate-none' : ''}`} aria-hidden="true" />
            <span className="text-body dark:text-body-xl" aria-live="polite">
              {captureLabel}
            </span>
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
            className="dw-input min-h-touch font-mono text-body-xl tracking-wider"
          />
          <p className="text-caption text-ink-3 dark:text-body-xl">Check the digits against the plate before asking.</p>
        </div>

        <div className="flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button type="button" className="dw-btn-secondary min-h-touch w-full sm:w-auto" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="dw-btn-primary min-h-touch w-full sm:w-auto" disabled={!serial.trim()}>
            Ask about this serial
          </button>
        </div>
      </form>
    </div>
  );
}
