import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Copy-to-clipboard for a serial/model number — gloved hands retyping a 16-character serial off a
 * screen is exactly the kind of friction this round is meant to remove. 44px tap target; falls back
 * silently (no crash, no misleading "Copied") when the Clipboard API isn't available (an insecure
 * context, an older WebView).
 */
export function CopyValueButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('no clipboard API');
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* no clipboard access — button simply does nothing rather than lie about it */
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      data-tap-target="true"
      className="inline-flex items-center justify-center w-11 h-11 shrink-0 rounded-md text-ink-3 hover:text-ink hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
    >
      {copied ? <Check className="w-4 h-4 text-ok" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
    </button>
  );
}
