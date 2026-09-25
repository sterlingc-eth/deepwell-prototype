import { useState } from 'react';
import { Check, Copy, Smartphone } from 'lucide-react';

/**
 * "Get your team on the phone app" (2026-09-25). The QR code
 * (public/get/qr.svg) opens https://deepwelltechnology.com/m/?install=1,
 * which shows the install steps for whatever phone scans it. /get is the
 * public install page to send people to.
 */
const GET_URL = 'https://deepwelltechnology.com/get';

export function PhoneAppCard() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(GET_URL);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt('Copy this link', GET_URL);
    }
  };
  return (
    <section aria-labelledby="phone-app-title" className="dw-card p-4 flex items-center gap-4 flex-wrap">
      <img
        src="/get/qr.svg"
        alt="QR code that opens DeepWell Mobile on a phone"
        width={112}
        height={112}
        className="w-28 h-28 rounded-md bg-white p-1 border border-line shrink-0"
      />
      <div className="flex-1 min-w-[220px] space-y-2">
        <h2 id="phone-app-title" className="text-body font-medium text-ink flex items-center gap-2">
          <Smartphone className="w-4 h-4" aria-hidden="true" />
          Phone app for your techs
        </h2>
        <p className="text-caption text-ink-2">
          Ask, scan and find documents from the job site. Scan the code with a phone camera, or send your team the
          link. It installs from the browser on iPhone and Android, with no app store. They sign in with the account
          you invited.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-2 min-h-touch px-3 rounded-md border border-line text-body hover:bg-surface-2 transition-colors duration-quick"
          >
            {copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
            {copied ? 'Link copied' : 'Copy install link'}
          </button>
          <a
            href="/get"
            target="_blank"
            rel="noopener"
            className="inline-flex items-center min-h-touch px-3 rounded-md text-body underline text-ink-2 hover:text-ink"
          >
            See install steps
          </a>
        </div>
      </div>
    </section>
  );
}
