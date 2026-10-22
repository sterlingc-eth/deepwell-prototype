/**
 * Industry picker for the demo account. Shown after the demo login (and from "Switch industry"): a grid of the
 * industries that have a demo company, grouped by category, with large tap targets for an iPad. Tapping a tile makes
 * that demo company the active organization and opens Donovan's Ask screen.
 */
import { useMemo, useState } from 'react';
import { useAuth, useClerk, useOrganizationList } from '@clerk/clerk-react';
import { ArrowRight, CheckCircle2, Loader2, LogOut, ShieldCheck, XCircle } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';
import { useAppStore } from '../store/appStore';
import { DEMO_CATEGORIES, DEMO_STARTERS, parseDemoOrgName, setDemoPicked } from './industries';
import { checkDemoCompany, type HealthRow } from './demoClient';

interface DemoOrg {
  id: string;
  industry: string;
  company: string;
}

export function DemoPicker() {
  const { isLoaded, setActive, userMemberships } = useOrganizationList({ userMemberships: { pageSize: 100 } });
  const { getToken } = useAuth();
  const { signOut } = useClerk();
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthRow[] | null>(null);
  const [checking, setChecking] = useState(false);

  const demoOrgs = useMemo<DemoOrg[]>(() => {
    const out: DemoOrg[] = [];
    for (const m of userMemberships?.data ?? []) {
      const parsed = parseDemoOrgName(m.organization.name);
      if (parsed) out.push({ id: m.organization.id, ...parsed });
    }
    return out;
  }, [userMemberships?.data]);
  const byIndustry = useMemo(() => new Map(demoOrgs.map((o) => [o.industry, o])), [demoOrgs]);
  const groups = DEMO_CATEGORIES.map((c) => ({ ...c, available: c.industries.filter((i) => byIndustry.has(i)) })).filter((c) => c.available.length > 0);

  const open = async (org: DemoOrg) => {
    if (!setActive) return;
    setOpening(org.industry);
    setError(null);
    try {
      await setActive({ organization: org.id });
      setDemoPicked(true);
      setCurrentScreen('ask');
    } catch {
      setError('That demo did not open. Check the connection and tap it again.');
      setOpening(null);
    }
  };

  const runHealthCheck = async () => {
    setChecking(true);
    setHealth([]);
    const rows: HealthRow[] = [];
    for (const org of demoOrgs) {
      const first = DEMO_STARTERS[org.industry]?.tryAsking[0] ?? DEMO_STARTERS[org.industry]?.all[0] ?? 'Which invoices are unpaid?';
      let token: string | null = null;
      try { token = await getToken({ organizationId: org.id, skipCache: true }); } catch { token = null; }
      rows.push(await checkDemoCompany(org.industry, first, token));
      setHealth([...rows]);
    }
    setChecking(false);
  };

  return (
    <div className="min-h-screen bg-bg text-ink flex flex-col">
      <header className="bg-forest-700 text-stone-0 border-b border-forest-800">
        <div className="max-w-content mx-auto px-4 sm:px-6 min-h-16 flex items-center gap-3">
          <Wordmark />
          <span className="ml-1 inline-flex items-center rounded-full bg-brass-300 text-forest-950 text-caption font-semibold px-2.5 py-0.5 tracking-wide">Demo</span>
          <button
            type="button"
            onClick={() => { setDemoPicked(false); void signOut({ redirectUrl: '/app/' }); }}
            className="ml-auto inline-flex items-center gap-2 min-h-touch px-3 rounded-md text-forest-100 hover:text-stone-0 hover:bg-forest-800"
          >
            <LogOut className="w-5 h-5" aria-hidden="true" /> <span>Sign out</span>
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-content mx-auto px-4 sm:px-6 py-8 sm:py-12">
        <h1 className="text-h1 sm:text-display font-semibold tracking-tight">Pick your industry</h1>
        <p className="mt-2 text-body-lg text-ink-2 max-w-[44rem]">
          Each one is a sample company with a few years of realistic paperwork. Ask Donovan anything about it, tap through to the source page, or scan a document of your own.
        </p>

        {error && <p role="alert" className="mt-4 text-bad-ink dark:text-bad-bg">{error}</p>}

        {!isLoaded ? (
          <div className="mt-10 flex items-center gap-2 text-ink-3" aria-busy="true"><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> Loading the demos…</div>
        ) : groups.length === 0 ? (
          <p className="mt-10 text-ink-2">No demo companies are set up for this login yet.</p>
        ) : (
          <div className="mt-8 space-y-10">
            {groups.map((g) => (
              <section key={g.title} aria-labelledby={`cat-${g.title}`}>
                <h2 id={`cat-${g.title}`} className="dw-label mb-3">{g.title}</h2>
                <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {g.available.map((industry) => {
                    const org = byIndustry.get(industry)!;
                    const busy = opening === industry;
                    return (
                      <li key={industry}>
                        <button
                          type="button"
                          onClick={() => void open(org)}
                          disabled={!!opening}
                          className="dw-card w-full min-h-[112px] text-left px-5 py-4 flex items-center gap-4 hover:border-forest-500 focus-visible:outline-brass-300 transition-colors duration-quick disabled:opacity-70"
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block text-h3 font-semibold text-ink">{industry}</span>
                            <span className="block mt-1 text-body text-ink-3 truncate">{org.company}</span>
                          </span>
                          {busy ? <Loader2 className="w-6 h-6 text-ink-3 animate-spin shrink-0" aria-hidden="true" /> : <ArrowRight className="w-6 h-6 text-ink-3 shrink-0" aria-hidden="true" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        <section className="mt-12 border-t border-line pt-6" aria-labelledby="demo-health">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="demo-health" className="text-body-lg font-semibold">Before the meeting</h2>
            <button type="button" onClick={() => void runHealthCheck()} disabled={checking || demoOrgs.length === 0} className="dw-btn-secondary !min-h-touch">
              {checking ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="w-4 h-4" aria-hidden="true" />}
              Check all demos
            </button>
          </div>
          {health && (
            <ul className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2" aria-live="polite">
              {health.map((h) => (
                <li key={h.industry} className="flex items-center gap-2 text-body">
                  {h.ok ? <CheckCircle2 className="w-5 h-5 text-ok shrink-0" aria-hidden="true" /> : <XCircle className="w-5 h-5 text-bad shrink-0" aria-hidden="true" />}
                  <span className="font-medium">{h.industry}</span>
                  <span className="text-ink-3">{h.ok ? `ready · ${h.documents} documents · ${(h.ms / 1000).toFixed(1)} s` : h.note}</span>
                </li>
              ))}
              {checking && <li className="text-ink-3">Checking…</li>}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
