import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { AlertTriangle, Camera, X } from 'lucide-react';
import { readPlate, LOW_CONFIDENCE, type PlateFields } from '../services/plateCapture';

interface SerialCaptureProps {
  onSerial: (serial: string) => void;
  onClose: () => void;
}

/**
 * Read a serial off a nameplate photo.
 *
 * This used to be a simulation: it waited 600ms and returned a random serial
 * already on file. In a demo that looks like it works. In an attic it hands a
 * technician another unit's serial with no indication anything is wrong, which
 * is the worst possible behaviour for the one screen whose entire job is to
 * replace typing with reading.
 *
 * It now takes a real photo and runs the real extractor. The photo is not
 * stored anywhere — /api/extract's image path is deliberately stateless, which
 * matters when the photo was taken inside somebody's home.
 *
 * `capture="environment"` opens the phone's own camera rather than a live
 * preview inside the page. That is the right trade for this user: the native
 * camera handles focus, glare and exposure far better than a video element,
 * it needs no permission prompt beyond the one the OS already handles, and it
 * keeps working when the app is installed to the home screen — where
 * getUserMedia has a long history of breaking on iOS.
 */
export function SerialCapture({ onSerial, onClose }: SerialCaptureProps) {
  const [serial, setSerial] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<{ fields: PlateFields; confidence: Record<string, number> } | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Revoke the object URL on unmount so a long field session doesn't hold
  // every photo the technician took in memory.
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset so picking the same photo twice still fires a change event.
    e.target.value = '';
    if (!file) return;

    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(file));
    setError(null);
    setRead(null);
    setReading(true);

    try {
      const result = await readPlate(file);
      setRead({ fields: result.fields, confidence: result.confidence });
      const found = result.fields.serial_number ?? '';
      setSerial(found.toUpperCase());
      if (!found) {
        setError("Couldn't find a serial on that photo. Fill the frame with the label and try again, or type it in.");
      }
      inputRef.current?.focus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong reading that photo.');
    } finally {
      setReading(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (serial.trim()) onSerial(serial.trim().toUpperCase());
  };

  const serialConfidence = read?.confidence?.serial_number;
  const unsure = typeof serialConfidence === 'number' && serialConfidence < LOW_CONFIDENCE;
  const other = read?.fields;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-6" role="presentation">
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-stone-950/50 cursor-default" tabIndex={-1} />
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="capture-title" className="relative w-full sm:max-w-md bg-surface text-ink rounded-t-xl sm:rounded-xl shadow-modal p-5 space-y-4 animate-rise">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="dw-label">Serial from photo</p>
            <h2 id="capture-title" className="font-sans font-semibold text-h3">
              Photograph the nameplate
            </h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="dw-btn-tertiary -mr-2 min-w-touch">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/*"
          capture="environment"
          onChange={onFile}
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
        />

        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={reading}
          className="w-full aspect-[4/3] rounded-lg border-2 border-dashed border-line-2 bg-bg grid place-items-center overflow-hidden text-ink-3 hover:border-forest-700 dark:hover:border-brass-300 transition-colors duration-quick"
        >
          {preview ? (
            <span className="relative w-full h-full">
              <img src={preview} alt="The nameplate you photographed" className="w-full h-full object-cover" />
              {reading && (
                <span className="absolute inset-0 bg-stone-950/60 grid place-items-center text-stone-0 text-body">
                  Reading the plate…
                </span>
              )}
            </span>
          ) : (
            <span className="flex flex-col items-center gap-2">
              <Camera className="w-8 h-8" aria-hidden="true" />
              <span className="text-body">Take a photo of the label</span>
              <span className="text-caption text-ink-3 px-6 text-center">
                Fill the frame with the plate. Nothing is saved unless you keep it.
              </span>
            </span>
          )}
        </button>

        {preview && !reading && (
          <button type="button" onClick={() => fileRef.current?.click()} className="dw-btn-tertiary -mt-2">
            Retake photo
          </button>
        )}

        {error && (
          <p role="status" className="flex items-start gap-2 text-body text-warn-ink dark:text-brass-200">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            {error}
          </p>
        )}

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
            className={[
              'dw-input font-mono text-body-xl tracking-wider',
              unsure ? 'border-warn' : '',
            ].join(' ')}
          />
          <p className="text-caption text-ink-3">
            {unsure
              ? 'Some characters were hard to make out. Check every digit against the plate.'
              : 'Check the digits against the plate before asking.'}
          </p>
          {other && (other.manufacturer || other.model) && (
            <p className="text-caption text-ink-3">
              Also read:{' '}
              {[other.manufacturer, other.model, other.equipment_type].filter(Boolean).join(' · ')}
            </p>
          )}
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
