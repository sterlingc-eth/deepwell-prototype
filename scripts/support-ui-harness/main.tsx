// Dev-only harness for scripts/verify-support-ui.mjs. fetch('/api/support') is answered by an in-page mock
// (no network, no backend); window.__calls records every request body so the verifier can assert on them.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { Moon } from 'lucide-react';
import { useAppStore } from '../../src/store/appStore';
import { Wordmark } from '../../src/components/Wordmark';
import { SupportWidget, SupportLauncherButton } from '../../src/components/support/SupportWidget';
import { SupportAssistant } from '../../src/components/support/SupportAssistant';
import { SupportLogo } from '../../src/components/support/SupportLogo';
import { Sheet } from '../../src/mobile/Sheet';
import '../../src/index.css';
import '../../src/mobile/mobile.css';

declare global {
  interface Window {
    __calls: { method: string; url: string; body: any }[];
    __askDonovan?: string;
    __rateLimit?: boolean;
  }
}
window.__calls = [];
window.__rateLimit = false;

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode') ?? 'desktop';
useAppStore.getState().setFieldMode(params.get('field') === '1');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hostile model/server replies (R34 break-it). The UI must render all of them as inert text.
export const HOSTILE = [
  '<img src=x onerror="window.__xss=1"> hi', '<script>window.__xss=2</script>', '<svg onload="window.__xss=3"></svg>', '[click](javascript:window.__xss=4)', 'javascript:window.__xss=5',
  'https://deepwelltechnology.com"onmouseover="window.__xss=6', '<a href="javascript:window.__xss=7">x</a>', '![x](https://evil.example/a.png)', '**<img src=x onerror=window.__xss=8>**',
  'data:text/html,<script>window.__xss=9</script>', '&lt;img src=x onerror=window.__xss=10&gt;', '`<img src=x onerror=window.__xss=11>`', 'A'.repeat(5000), '<iframe src="javascript:window.__xss=12"></iframe>',
];
const realFetch = window.fetch.bind(window);
window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (!url.startsWith('/api/support')) return realFetch(input, init);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  window.__calls.push({ method, url, body });
  await sleep(250);
  if (method === 'GET') {
    return json(200, { greeting: "Hi, I'm DeepWell Help. Ask me how DeepWell works.", suggestions: ['How do I upload documents?', 'What plans are available?', 'How do I add a teammate?'] });
  }
  if (body?.action === 'handoff') {
    if (String(body.email).includes('fail')) return json(500, { error: 'nope' });
    return json(200, { ok: true });
  }
  const m = String(body?.message ?? '');
  if (window.__rateLimit) {
    window.__rateLimit = false;
    return json(429, { error: 'Too many requests', retryAfterSec: 3 });
  }
  const hostile = /^hostile(\d+)$/.exec(m);
  if (hostile) {
    const bad = HOSTILE[Number(hostile[1])];
    return json(200, { reply: bad, sources: [{ id: 'x', title: '<img src=x onerror=window.__xss=30>' }], mode: 'faq', suggestions: ['<img src=x onerror=window.__xss=31>', 'javascript:window.__xss=32'] });
  }
  if (/boom/i.test(m)) return json(500, { error: 'internal' });
  if (/records|installed|trane/i.test(m)) {
    return json(200, { reply: "That's a question about your own records. **Donovan** answers those from your documents.", sources: [], mode: 'redirect', redirectTo: 'ask' });
  }
  if (/human|refund/i.test(m)) {
    return json(200, { reply: 'I can pass this to a person on the DeepWell team.', sources: [], mode: 'guard', handoff: { offered: true, reason: 'refund' } });
  }
  if (/html/i.test(m)) {
    return json(200, { reply: '<img src=x onerror="window.__xss=1"> **Bold text** and https://deepwelltechnology.com/pricing. Email support@deepwelltechnology.com.', sources: [], mode: 'faq' });
  }
  return json(200, {
    reply: 'You can upload PDFs and photos from the **Inbox** on desktop, or use the Scan tab on your phone.\n\n- Files are read within a few minutes\n- Anything unclear lands in Needs a person\n\nSee https://deepwelltechnology.com/get for the phone app.',
    sources: [{ id: 'upl', title: 'Uploading and scanning' }, { id: 'upl', title: 'Uploading and scanning' }],
    mode: 'faq',
    suggestions: ['What file types work?', 'How long does scanning take?'],
  });
}) as typeof window.fetch;

function DesktopPage() {
  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="bg-forest-700 text-stone-0 px-6 h-14 flex items-center">DeepWell (harness page)</header>
      <main className="max-w-ask mx-auto p-6">
        <h1>Ask</h1>
        <p>Harness page content. The floating Help launcher sits bottom-right.</p>
        <textarea className="w-full border border-line-2 bg-surface rounded-lg p-3 mt-4" rows={3} placeholder="Ask a question about your records" />
      </main>
      <SupportWidget page="ask" userEmail="pat@sunrisehvac.com" userName="Pat Owner" onAskDonovan={(q) => { window.__askDonovan = q; }} />
    </div>
  );
}

function MobilePage() {
  const [open, setOpen] = useState(false);
  return (
    <div className="dw-m h-[100dvh] bg-bg text-ink flex flex-col">
      <header className="dw-safe-top shrink-0 bg-surface border-b border-line/60">
        <div className="max-w-2xl mx-auto min-h-14 px-4 flex items-center justify-between gap-3">
          <Wordmark size="sm" />
          <div className="flex items-center gap-2">
            <SupportLauncherButton size={44} pulsing={true} onClick={() => setOpen(true)} className="shrink-0" />
            <button type="button" aria-label="Theme" className="w-11 h-11 -mr-1 flex items-center justify-center rounded-full text-ink-3"><Moon className="w-5 h-5" /></button>
          </div>
        </div>
      </header>
      <main className="flex-1 p-4">Harness Ask tab</main>
      <nav className="dw-safe-bottom shrink-0 border-t border-line/60 bg-surface">
        <div className="max-w-md mx-auto grid grid-cols-3">
          {['Ask', 'Scan', 'Docs'].map((t) => <button key={t} type="button" className="min-h-16 text-caption text-ink-3">{t}</button>)}
        </div>
      </nav>
      {open && (
        <Sheet fill title="DeepWell Help" icon={<SupportLogo plate size={32} />} onClose={() => setOpen(false)}>
          <SupportAssistant surface="mobile" page="mobile:ask" variant="embedded" userEmail="pat@sunrisehvac.com" onAskDonovan={(q) => { window.__askDonovan = q; setOpen(false); }} />
        </Sheet>
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(mode === 'mobile' ? <MobilePage /> : <DesktopPage />);
