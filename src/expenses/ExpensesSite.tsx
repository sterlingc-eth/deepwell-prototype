/**
 * Standalone UI for the founders' business-expense site
 * (deepwelltechnology.com/expenses/). A separate Vite page from the customer
 * app: it imports none of App.tsx, the app store, or AppShell, and nothing in
 * the customer app links to it. Access is enforced server-side
 * (api/_lib/routes/expenses.js -> isPlatformOperator); the operatorStatus
 * check below only decides what to render.
 */
import { useCallback, useEffect, useState } from 'react'
import { SignIn, useAuth, useClerk, useUser } from '@clerk/clerk-react'
import { LogOut } from 'lucide-react'
import { Wordmark } from '../components/Wordmark'
import { ExpensesScreen } from '../screens/ExpensesScreen'
import { fetchExpensesOperatorStatus } from '../services/expensesClient'
import { setAuthTokenProvider } from '../services/authToken'

type Gate = 'checking' | 'ok' | 'denied' | 'error'

function Header() {
  const { user } = useUser()
  const { signOut } = useClerk()
  const email = user?.primaryEmailAddress?.emailAddress
  return (
    <header className="border-b border-line bg-surface">
      <div className="max-w-content mx-auto px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Wordmark />
          <span className="text-h4 text-ink">Business Expenses</span>
        </div>
        {user && (
          <div className="flex items-center gap-3 text-body text-ink-2">
            {email && <span className="hidden sm:inline">{email}</span>}
            <button type="button" className="dw-btn-secondary" onClick={() => void signOut({ redirectUrl: '/expenses/' })}>
              <LogOut className="w-4 h-4" aria-hidden="true" /> Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="max-w-content mx-auto px-4 py-16 text-center space-y-4">{children}</div>
}

function Protected() {
  const { getToken } = useAuth()
  const [gate, setGate] = useState<Gate>('checking')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    setAuthTokenProvider(() => getToken())
    return () => setAuthTokenProvider(null)
  }, [getToken])

  // The SERVER decides (api/_lib/routes/expenses.js isExpensesOperator:
  // allowlist, or membership of the founder org whichever org is active).
  // This never touches the active Clerk org.
  useEffect(() => {
    let cancelled = false
    fetchExpensesOperatorStatus()
      .then((r) => { if (!cancelled) setGate(r.isOperator ? 'ok' : 'denied') })
      .catch((e) => {
        const status = (e as { status?: number }).status
        if (!cancelled) setGate(status === 403 ? 'denied' : 'error')
      })
    return () => { cancelled = true }
  }, [attempt])

  const retry = useCallback(() => { setGate('checking'); setAttempt((n) => n + 1) }, [])

  if (gate === 'checking') return <Centered><p className="text-body-lg text-ink-2" aria-busy="true">Checking access...</p></Centered>
  if (gate === 'denied') return <Centered><p className="text-body-lg text-ink">This site is for DeepWell staff only.</p></Centered>
  if (gate === 'error') {
    return (
      <Centered>
        <p className="text-body-lg text-ink">Could not verify access. Check your connection and try again.</p>
        <button type="button" className="dw-btn-secondary" onClick={retry}>Try again</button>
      </Centered>
    )
  }
  return <main className="max-w-content mx-auto px-4 py-6"><ExpensesScreen /></main>
}

export function Site() {
  const { isLoaded, isSignedIn } = useAuth()
  return (
    <div className="min-h-screen bg-bg text-ink">
      <Header />
      {!isLoaded ? (
        <Centered><p className="text-body-lg text-ink-2" aria-busy="true">Loading...</p></Centered>
      ) : isSignedIn ? (
        <Protected />
      ) : (
        <div className="flex justify-center px-4 py-12">
          <SignIn routing="hash" signUpUrl={undefined} forceRedirectUrl="/expenses/" />
        </div>
      )}
    </div>
  )
}

