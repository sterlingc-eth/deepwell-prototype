/**
 * Standalone entry for the founders' business-expense site
 * (deepwelltechnology.com/expenses/) — see ExpensesSite.tsx.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ClerkProvider } from '@clerk/clerk-react'
import '../index.css'
import { Site } from './ExpensesSite'

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY
if (!clerkPublishableKey) {
  throw new Error('Missing VITE_CLERK_PUBLISHABLE_KEY environment variable')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ClerkProvider
      publishableKey={clerkPublishableKey}
      localization={{ signIn: { start: { title: 'DeepWell business expenses', subtitle: 'Staff sign-in.' } } }}
    >
      <Site />
    </ClerkProvider>
  </StrictMode>,
)
