// See harness.html's comment.
import { createRoot } from 'react-dom/client'
import { ScanTab } from '../../src/mobile/ScanTab'
import '../../src/index.css'
import '../../src/mobile/mobile.css'

declare global {
  interface Window {
    __dwSetDark?: (on: boolean) => void
    __dwUploaded?: number
    __dwOpenedDocs?: number
  }
}
window.__dwSetDark = (on: boolean) => document.documentElement.classList.toggle('dark', on)
window.__dwUploaded = 0
window.__dwOpenedDocs = 0

const TENANT = 'harness-tenant'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <div style={{ height: '100vh' }}>
      <ScanTab
        tenantKey={TENANT}
        onUploaded={() => {
          window.__dwUploaded = (window.__dwUploaded ?? 0) + 1
        }}
        onOpenDocs={() => {
          window.__dwOpenedDocs = (window.__dwOpenedDocs ?? 0) + 1
        }}
      />
    </div>,
  )
}
