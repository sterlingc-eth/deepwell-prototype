/**
 * Browser client for Company Files (POST /api/records: companyFiles, moveCompanyFile, undoCompanyFileMove,
 * setCompanyFilesHrAccess). The server decides what this person may see; People and HR is simply absent for anyone without
 * access.
 */
import { authHeader } from './authToken';
import type { CompanyFolderId, CheckReason, FolderLayout } from '../core/companyFiles';

export interface CfDoc {
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  folder: CompanyFolderId;
  /** A person chose this folder (as opposed to it being filed automatically). */
  moved: boolean;
  vendor: string | null;
  vendorKey: string;
  invoiceNumber: string | null;
  amount: number | null;
  date: string | null;
  createdAt: string;
  expires: string | null;
  expiryState: 'upcoming' | 'expired' | null;
  daysLeft: number | null;
  older: boolean;
  replaced: boolean;
  flags: CheckReason[];
  stage: string;
}

export interface CfStrip { count: number; items: CfDoc[] }
export interface CfFolderCount { id: CompanyFolderId; label: string; count: number; check: number }
export interface CfHome {
  folders: CfFolderCount[];
  total: number;
  comingUp: CfStrip;
  checkThese: CfStrip;
  canSeeHr: boolean;
  canEditHrAccess?: boolean;
  hrAccess?: { roles: string[]; members: string[] };
  truncated: boolean;
}
export interface CfFolderView {
  folder: { id: CompanyFolderId; label: string; layout: FolderLayout };
  total: number;
  docs: CfDoc[];
  vendors: { key: string; name: string; count: number; latest: string | null; older: number; flagged: number }[];
  kinds: { type: string; label: string; count: number }[];
  months: { month: string; count: number }[];
  checkThese: CfStrip;
  comingUp: CfStrip;
  truncated: boolean;
}
export interface CfSearch { q: string; total: number; docs: CfDoc[]; truncated: boolean }

export interface CfMoveResult {
  documentId: string;
  to: string;
  toLabel: string;
  previousOverride: string | null;
  vendor: string | null;
  ruleKey: string | null;
  previousRule: string | null;
  ruleFolder: string | null;
}

async function call<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch('/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ action, ...payload }),
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let message = `API error ${response.status}`;
    try { const p = JSON.parse(raw); if (p?.error) message = String(p.error); } catch { /* keep the status message */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const companyFilesHome = () => call<CfHome>('companyFiles', { view: 'home' });
export const companyFilesFolder = (folder: string) => call<CfFolderView>('companyFiles', { view: 'folder', folder });
export const companyFilesSearch = (q: string, folder?: string | null) => call<CfSearch>('companyFiles', { view: 'search', q, folder: folder ?? null });
export const moveCompanyFile = (documentId: string, to: string, alwaysFile: boolean) => call<CfMoveResult>('moveCompanyFile', { documentId, to, alwaysFile });
export const undoCompanyFileMove = (m: CfMoveResult) => call<{ documentId: string }>('undoCompanyFileMove', {
  documentId: m.documentId, previousOverride: m.previousOverride, ruleKey: m.ruleKey, previousRule: m.previousRule, ruleFolder: m.ruleFolder,
});
export const setCompanyFilesHrAccess = (roles: string[], members: string[] = []) => call<{ hrAccess: { roles: string[]; members: string[] } }>('setCompanyFilesHrAccess', { roles, members });
