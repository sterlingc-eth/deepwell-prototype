import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { DemoApp } from './DemoApp'
import { demoFlagOn } from './engine'
import { HomeBackBar } from './HomeBackBar'

// Demo mode (/demo/): an industry picker over fully synthetic sample workspaces. No sign-in, no API calls, no database:
// nothing here can see or touch a customer's records. Built and shown only when VITE_DEEPWELL_DEMO is "true".
const on = demoFlagOn(import.meta.env as unknown as Record<string, unknown>)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {on ? <DemoApp /> : (
      <div className="min-h-screen bg-bg text-ink">
        <HomeBackBar />
        <main className="grid place-items-center p-6 text-ink-2">
          <p>This page is not available.</p>
        </main>
      </div>
    )}
  </StrictMode>,
)
