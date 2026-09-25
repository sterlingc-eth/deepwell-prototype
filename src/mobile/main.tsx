import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import '../index.css'
import './mobile.css'
import { MobileApp } from './MobileApp'
import { registerServiceWorker } from './pwa'

// DeepWell Mobile (/m/): the lite field app for techs and managers — Ask,
// Scan, Docs. Same Clerk session, same API, same tenant scoping as /app; it
// just renders a phone-first shell over the existing service layer.

// Same bfcache guard as src/main.tsx: a Back-restored snapshot could be an
// old build after a deploy.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload()
})

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
if (!clerkPublishableKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY environment variable')
}

const localization = {
  signIn: { start: { title: 'Sign in to DeepWell', subtitle: 'Welcome back. Please sign in to continue.' } },
  signUp: { start: { title: 'Create your DeepWell account', subtitle: 'Enter your details to get started.' } },
}

registerServiceWorker()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider publishableKey={clerkPublishableKey} localization={localization}>
      <MobileApp />
    </ClerkProvider>
  </StrictMode>,
)
