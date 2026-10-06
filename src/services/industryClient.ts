/**
 * Change this company's trade (Build 2, stage 2E). POST /api/account?action=industry { op: 'set' } is owner / admin
 * only and audit-logged on the server; it saves the choice and drops this company's cached answers so none is served
 * in the old trade's words. No document, record or setting is deleted by a change.
 */
import { authHeader } from './authToken';
import { isIndustryId, type IndustryId, type IndustryInfo } from '../lib/industry';

export class IndustryChangeError extends Error {}

export async function changeIndustry(industry: IndustryId): Promise<IndustryInfo> {
  if (!isIndustryId(industry)) throw new IndustryChangeError('Pick one of the listed trades.');
  let res: Response;
  try {
    res = await fetch('/api/account?action=industry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ op: 'set', industry }),
    });
  } catch {
    throw new IndustryChangeError('Could not reach DeepWell. Nothing was changed. Check your connection and try again.');
  }
  if (res.status === 403) throw new IndustryChangeError('Only an admin can change the trade. Nothing was changed.');
  if (!res.ok) throw new IndustryChangeError('Could not change the trade. Nothing was changed. Try again in a moment.');
  return (await res.json()) as IndustryInfo;
}
