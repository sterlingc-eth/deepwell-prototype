import type { ComponentType } from 'react';
import { Database, Inbox, LayoutDashboard } from 'lucide-react';
import { AskMark } from './AskMark';
import type { Screen } from '../store/appStore';

/**
 * The primary navigation, in a CSS-free module. It used to live in AppShell.tsx, which imports the support
 * widget and therefore support.css; `tsx scripts/verify-ui.ts` (npm run verify:ui, part of verify:all) imports
 * NAV and could no longer load the stylesheet (ERR_UNKNOWN_FILE_EXTENSION). Keep this file free of any
 * `import './x.css'` (directly or through what it imports).
 */

export interface NavItem {
  screen: Screen;
  label: string;
  icon: ComponentType<{ className?: string; active?: boolean }>;
  /** Screens that should light up this nav item */
  matches: Screen[];
}

// Exactly four primary destinations — Ask, Dashboard, Inbox, Records. Browse
// merged into Records (as its Documents/Customers/Company Files/Grid tabs — round 17
// folded the old standalone Search tab into ⌘K and the Documents/Customers
// tabs' own search boxes instead, see BrowseScreen.tsx); the old standalone
// Records screen's health metrics moved into Dashboard's "Data health"
// strip; 'review' and 'records' are retired ids kept as aliases (see
// store/appStore.ts) so they still light up the right item here.
export const NAV: NavItem[] = [
  { screen: 'ask', label: 'Ask', icon: AskMark, matches: ['ask', 'entity'] },
  { screen: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, matches: ['dashboard', 'warranty-export', 'records'] },
  { screen: 'ingest', label: 'Inbox', icon: Inbox, matches: ['ingest', 'review'] },
  { screen: 'browse', label: 'Records', icon: Database, matches: ['browse', 'customer'] },
];
