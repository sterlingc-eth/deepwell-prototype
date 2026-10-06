import { useEffect, useState, type CSSProperties } from 'react';
import { CreateOrganization, OrganizationList, useAuth, useClerk } from '@clerk/clerk-react';
import { ArrowLeft, Building2, LogOut, Users } from 'lucide-react';
import { Wordmark } from '../components/Wordmark';
import { deepLinkRedirectTarget } from '../hooks/useDeepLink';
import { INDUSTRY_CHOICES, PENDING_INDUSTRY_KEY, encodePendingIndustry, type IndustryId } from '../lib/industry';

/** Matches LoginScreen's plate so the two screens read as one flow. */
const PLATE = '#F6F8F6';

type Mode = 'choose' | 'industry' | 'create' | 'join';

const clerkAppearance = {
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'w-full shadow-none border-0',
    card: 'w-full shadow-none border-0 mx-auto',
    formFieldInput: 'w-full',
  },
  variables: {
    colorPrimary: '#0D3827',
    colorBackground: PLATE,
  },
} as const;

/** The plate is a fixed light surface, but a first-time visitor lands here in the default Office (dark) theme,
 *  where the ink/surface tokens are light-on-dark — the intro copy and both option cards became near-invisible
 *  pale-on-pale. Re-pin the light token values for everything inside the plate. */
const LIGHT_PLATE_TOKENS = {
  '--dw-bg': '#f6f8f6',
  '--dw-surface': '#ffffff',
  '--dw-surface-2': '#ecf0ed',
  '--dw-ink': '#0d110e',
  '--dw-ink-2': '#3c463f',
  '--dw-ink-3': '#5f6d64',
  '--dw-line': '#dce3de',
  '--dw-line-2': '#c2ccc5',
  color: '#0d110e',
} as const;

/**
 * Gate shown to a signed-in user who has no active Clerk organization.
 *
 * DeepWell is shared per-shop, not per-technician: api/_lib/auth.js treats a
 * user with no org as their OWN solo tenant (`user_<clerkUserId>`), which is
 * exactly the silent-fragmentation bug this screen exists to stop technicians
 * from falling into by accident. App.tsx renders this instead of the app for
 * any signed-in user with no `orgId`, and stops rendering it the moment Clerk
 * makes an organization active — creating one, accepting an invite, or
 * picking one from OrganizationList all do that, and App.tsx's own effect
 * (not this component, which unmounts the instant that happens) is what
 * kicks off moving any solo work into the new shop — see App.tsx's
 * `mergeNotice` effect and HANDOFF.md for the `/api/merge-tenant` endpoint it
 * calls optimistically.
 */
export function OnboardingScreen() {
  const [mode, setMode] = useState<Mode>('choose');
  const [industry, setIndustry] = useState<IndustryId>('hvac');
  // A pick only counts while the person is actually creating a company: going back or choosing "I was invited"
  // drops it, so it can never be applied to a company they merely joined.
  useEffect(() => {
    if (mode === 'choose' || mode === 'join') {
      try {
        window.localStorage.removeItem(PENDING_INDUSTRY_KEY);
      } catch {
        /* storage blocked: nothing was saved */
      }
    }
  }, [mode]);
  const { signOut } = useClerk();
  const { userId } = useAuth();
  // Carries a `?plan=`/`?screen=` deep link through org creation/selection —
  // both do a real page navigation, which loses the plan pick that had
  // already been applied to the (now-discarded) in-memory store. See
  // useDeepLink.ts's DEEP_LINK_STORAGE_KEY comment.
  const redirectTarget = deepLinkRedirectTarget();

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#163C2C] to-[#0F2818] flex flex-col items-center justify-center gap-4 sm:gap-8 p-4">
      <div className="dw-rise flex flex-col items-center text-center">
        <h1 className="m-0">
          <Wordmark size="lg" />
        </h1>
        <p className="text-forest-100 mt-2 sm:mt-4 text-body-lg">
          {mode === 'choose' ? "You're signed in — now join or start a company." : 'Almost there.'}
        </p>
      </div>

      <div
        className="dw-rise dw-rise-late w-full max-w-md rounded-lg shadow-xl p-4 sm:p-8 flex flex-col gap-3 sm:gap-5"
        style={{ background: PLATE, ...LIGHT_PLATE_TOKENS } as CSSProperties}
      >
        {mode === 'choose' && (
          <>
            <p className="text-body text-ink-2">
              DeepWell accounts belong to a company, not to one person, so every
              document and record your whole team touches ends up in the same
              place. Create your company, or join one you were invited to.
            </p>

            <button
              type="button"
              onClick={() => setMode('industry')}
              className="dw-card border-line px-4 py-3 flex items-center gap-3 text-left hover:border-forest-700 focus-visible:outline-brass-300 transition-colors duration-quick"
            >
              <Building2 className="w-5 h-5 text-forest-700 shrink-0" aria-hidden="true" />
              <span>
                <span className="block font-medium text-ink">Create your company</span>
                <span className="block text-caption text-ink-3">
                  You're the first one here — set it up for your team.
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setMode('join')}
              className="dw-card border-line px-4 py-3 flex items-center gap-3 text-left hover:border-forest-700 focus-visible:outline-brass-300 transition-colors duration-quick"
            >
              <Users className="w-5 h-5 text-forest-700 shrink-0" aria-hidden="true" />
              <span>
                <span className="block font-medium text-ink">I was invited</span>
                <span className="block text-caption text-ink-3">
                  Accept an invite, or switch to a company you already belong to.
                </span>
              </span>
            </button>
          </>
        )}

        {mode === 'industry' && (
          <>
            <button
              type="button"
              onClick={() => setMode('choose')}
              className="inline-flex items-center gap-2 min-h-touch text-body text-ink-2 hover:text-ink self-start focus-visible:outline-brass-300 rounded-md"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Back
            </button>
            <fieldset className="flex flex-col gap-2 sm:gap-3 border-0 p-0 m-0">
              <legend className="text-body text-ink-2 mb-1">
                What kind of work do you do? Pick the one you do most.
              </legend>
              {INDUSTRY_CHOICES.map((c) => (
                <label
                  key={c.id}
                  className={`dw-card px-4 py-3 min-h-[44px] flex items-start gap-3 cursor-pointer ${industry === c.id ? 'border-forest-700' : 'border-line'}`}
                >
                  <input
                    type="radio"
                    name="industry"
                    value={c.id}
                    checked={industry === c.id}
                    onChange={() => setIndustry(c.id)}
                    className="mt-1"
                  />
                  <span>
                    <span className="block font-medium text-ink">{c.label}</span>
                    <span className="block text-caption text-ink-3">{c.blurb}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <button
              type="button"
              onClick={() => {
                try {
                  window.localStorage.setItem(PENDING_INDUSTRY_KEY, encodePendingIndustry(industry, userId ?? '', Date.now()));
                } catch {
                  /* storage blocked: the company simply starts as HVAC, the default, and can change it later */
                }
                setMode('create');
              }}
              className="dw-btn-primary w-full focus-visible:outline-brass-300"
            >
              Continue
            </button>
            <p className="text-caption text-ink-3 -mt-1">A company uses one trade. You can change it any time in Settings, and nothing you file is lost.</p>
          </>
        )}

        {mode === 'create' && (
          <>
            <button
              type="button"
              onClick={() => setMode('industry')}
              className="inline-flex items-center gap-2 min-h-touch text-body text-ink-2 hover:text-ink self-start focus-visible:outline-brass-300 rounded-md"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Back
            </button>
            <CreateOrganization
              hideSlug
              skipInvitationScreen={false}
              // Without this Clerk falls back to the dashboard "home URL" —
              // the marketing site — so a new shop landed on the website
              // instead of the app (owner report, 2026-09-20).
              afterCreateOrganizationUrl={redirectTarget}
              appearance={clerkAppearance}
            />
          </>
        )}

        {mode === 'join' && (
          <>
            <button
              type="button"
              onClick={() => setMode('choose')}
              className="inline-flex items-center gap-2 min-h-touch text-body text-ink-2 hover:text-ink self-start focus-visible:outline-brass-300 rounded-md"
            >
              <ArrowLeft className="w-4 h-4" aria-hidden="true" />
              Back
            </button>
            <p className="text-body text-ink-2">
              An invite from your company's admin arrives by email with a link that
              signs you straight in. If you already accepted one, or you belong
              to a company already, pick it below to make it active.
            </p>
            <OrganizationList
              hidePersonal
              afterSelectOrganizationUrl={redirectTarget}
              afterCreateOrganizationUrl={redirectTarget}
              appearance={clerkAppearance}
            />
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => { void signOut({ redirectUrl: '/app/' }); }}
        className="dw-rise dw-rise-late inline-flex items-center gap-2 min-h-touch px-3 rounded-md text-forest-100 hover:text-stone-0 hover:bg-white/10 transition-colors duration-quick focus-visible:outline-brass-300"
      >
        <LogOut className="w-4 h-4" aria-hidden="true" />
        <span className="text-body">Sign out</span>
      </button>
    </div>
  );
}
