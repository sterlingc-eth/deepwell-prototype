import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useLauncherPulse } from './useLauncherPulse';
import { useOrganization } from '@clerk/clerk-react';
import { SupportLogo } from './SupportLogo';
import { SupportAccessBanner } from './SupportAccess';
import './support.css';

// The chat itself loads on first open: AppShell wraps every screen and must stay light for startup speed.
const SupportAssistant = lazy(() => import('./SupportAssistant').then((m) => ({ default: m.SupportAssistant })));

export function SupportLoading() {
  return (
    <div className="flex-1 flex items-center justify-center text-accent-ink" aria-busy="true">
      <SupportLogo pulsing size={40} />
    </div>
  );
}

/** Circles-logo launcher button. `size` px (desktop 56, mobile header 44). */
export function SupportLauncherButton({ pulsing, size, onClick, buttonRef, className = '' }: { pulsing: boolean; size: number; onClick: () => void; buttonRef?: React.Ref<HTMLButtonElement>; className?: string }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      aria-label="Open DeepWell Help chat"
      title="DeepWell Help"
      style={{ width: size, height: size }}
      className={`rounded-full p-0 flex items-center justify-center bg-[#0B1613] border border-brass-500/50 ${pulsing ? 'dw-support-launcher-pulse' : ''} ${className}`}
    >
      <SupportLogo pulsing={pulsing} size={Math.round(size * 0.66)} className="text-brass-300" />
    </button>
  );
}

/**
 * Desktop: floating launcher bottom-right (below modals, clear of the header and toasts) that opens a
 * 380x560 slide-up panel in the same corner. The panel stays mounted after its first open so a reply that
 * lands while it is closed is not lost.
 */
export function SupportWidget({ page, userEmail, userName, onAskDonovan }: { page?: string; userEmail?: string; userName?: string; onAskDonovan?: (q: string) => void }) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const pulsing = useLauncherPulse(open);
  const { organization } = useOrganization();

  const close = useCallback(() => setOpen(false), []);
  // The Ask screen's "Open DeepWell Help" button (a how-to answer from the Help guide) opens this same panel.
  useEffect(() => {
    const openFromAsk = () => { setEverOpened(true); setOpen(true); };
    window.addEventListener('deepwell:open-help', openFromAsk);
    return () => window.removeEventListener('deepwell:open-help', openFromAsk);
  }, []);
  useEffect(() => {
    if (wasOpen.current && !open) launcherRef.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);

  const pos = { right: 'max(1rem, env(safe-area-inset-right))', bottom: 'max(1rem, env(safe-area-inset-bottom))' } as const;
  return (
    <>
      <SupportAccessBanner surface="app" />
      {!open && (
        <div className="fixed z-30 print:hidden" style={pos}>
          <SupportLauncherButton
            buttonRef={launcherRef}
            size={56}
            pulsing={pulsing}
            onClick={() => {
              setEverOpened(true);
              setOpen(true);
            }}
            className="shadow-lift hover:brightness-110"
          />
        </div>
      )}
      {everOpened && (
        <div className="fixed z-40 print:hidden w-[380px] h-[560px] max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)]" style={{ ...pos, display: open ? undefined : 'none' }}>
          <Suspense fallback={<SupportLoading />}>
          <SupportAssistant
            surface="app"
            page={page}
            variant="panel"
            active={open}
            onClose={close}
            userEmail={userEmail}
            userName={userName}
            companyName={organization?.name ?? ''}
            onAskDonovan={
              onAskDonovan
                ? (q) => {
                    onAskDonovan(q);
                    close();
                  }
                : undefined
            }
          />
          </Suspense>
        </div>
      )}
    </>
  );
}
