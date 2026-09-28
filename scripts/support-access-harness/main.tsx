// Dev-only harness for scripts/verify-support-access-ui.mjs — mounts SupportAccessCard with
// reviewClient's network methods monkey-patched to fixture data (reviewClient is a plain exported
// object, not frozen — same technique scripts/learning-harness/main.tsx already uses). Nothing here
// ever calls the network or a database.
import { createRoot } from 'react-dom/client';
import { reviewClient } from '../../src/services/reviewClient';
import type { SupportAccessGrant, StaffAccessLogEntry } from '../../src/services/reviewClient';
import { useAppStore } from '../../src/store/appStore';
import { SupportAccessCard } from '../../src/screens/TeamScreen';
import '../../src/index.css';

const NOW = Date.now();

const ACTIVE_GRANT: SupportAccessGrant = {
  id: 'grant-1',
  granted_by: 'user_admin_1',
  reason: 'Helping debug a missing invoice on a work order',
  expires_at: new Date(NOW + 20 * 3600_000).toISOString(),
  created_at: new Date(NOW - 4 * 3600_000).toISOString(),
};

const LOG_ENTRIES: StaffAccessLogEntry[] = [
  {
    id: 'log-1', staff_user_id: 'user_support_2', action: 'examList', record_count: 12,
    is_emergency: false, emergency_reason: null, grant_id: 'grant-1', created_at: new Date(NOW - 2 * 3600_000).toISOString(),
  },
  {
    id: 'log-2', staff_user_id: 'user_support_3', action: 'learningReplay', record_count: 5,
    is_emergency: true, emergency_reason: 'Customer called in about a missing warranty answer; admin unreachable overnight.',
    grant_id: null, created_at: new Date(NOW - 26 * 3600_000).toISOString(),
  },
  {
    id: 'log-3', staff_user_id: 'user_support_2', action: 'examPromote', record_count: 1,
    is_emergency: false, emergency_reason: null, grant_id: 'grant-0', created_at: new Date(NOW - 3 * 24 * 3600_000).toISOString(),
  },
];

const params = new URLSearchParams(window.location.search);
const state = params.get('state') ?? 'active'; // 'active' | 'empty'

reviewClient.supportAccessStatus = () => Promise.resolve({
  active: state === 'active' ? ACTIVE_GRANT : null,
  history: state === 'active' ? [ACTIVE_GRANT] : [],
});
reviewClient.supportAccessLog = () => Promise.resolve({ items: state === 'active' ? LOG_ENTRIES : [] });
reviewClient.supportAccessGrant = () => Promise.resolve({ ok: true, grant: ACTIVE_GRANT });
reviewClient.supportAccessRevoke = () => Promise.resolve({ ok: true });

useAppStore.getState().setFieldMode(params.get('field') === '1');

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <div className="max-w-2xl mx-auto p-4" data-testid="harness-root">
      <SupportAccessCard />
    </div>,
  );
}
