import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import { bootstrapHvac } from './domains/hvac'

// Demo fixture is opt-in, not the default: a signed-in user with real
// Postgres data must never see it mixed with theirs. `usePostgresSync` (see
// App.tsx) is the default data path and replaces whatever is in the store,
// including this fixture, the moment it loads — so when demo mode is off,
// skipping the bootstrap entirely (rather than calling it and letting sync
// overwrite it) just avoids a pointless flash of fixture data on first paint.
// Compared with plain string 'true', never a boolean: import.meta.env.* is
// inlined as a string literal at build time, and a missing var is `undefined`
// here, not `false` — no throw, so a build with no env file simply stays out
// of demo mode instead of taking the app down.
if (import.meta.env.VITE_DEMO_MODE === 'true') {
  bootstrapHvac()
}

// Chrome's back-forward cache can restore a full pre-navigation DOM/JS
// snapshot on Back with no re-fetch of the current bundle — after a deploy,
// that's the OLD app, indistinguishable from the real thing until something
// breaks. `event.persisted` is only ever true for a bfcache restore (never a
// normal load), so reloading there gets back onto whatever is live now.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) {
    window.location.reload()
  }
})

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY

if (!clerkPublishableKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY environment variable')
}

// Clerk's default copy uses the application name from the Clerk dashboard,
// which renders lowercase ("Sign in to deepwell"). Pin the wording here so the
// brand is spelled correctly regardless of that setting.
const localization = {
  signIn: {
    start: {
      title: 'Sign in to DeepWell',
      subtitle: 'Welcome back. Please sign in to continue.',
    },
  },
  signUp: {
    start: {
      title: 'Create your DeepWell account',
      subtitle: 'Enter your details to get started.',
    },
  },
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={clerkPublishableKey} localization={localization}>
      <App />
    </ClerkProvider>
  </StrictMode>,
)

