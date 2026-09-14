import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import './index.css'
import App from './App.tsx'
import { bootstrapHvac } from './domains/hvac'

bootstrapHvac()

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

