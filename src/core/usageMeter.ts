/** Billing usage meters (R31 QA): "745 / 750" told the owner nothing until uploads stopped. Pure helpers. */
export type MeterTone = 'ok' | 'warn' | 'bad';
export interface UsageMeter {
  /** 0-100, integer. Unlimited caps have no meter. */
  pct: number;
  tone: MeterTone;
  /** true at >= 80% of the cap. */
  near: boolean;
  /** true at >= 100%. */
  over: boolean;
}

export function usageMeter(used: number, cap: number | null | undefined): UsageMeter | null {
  if (cap == null || !Number.isFinite(cap) || cap <= 0) return null;
  const u = Math.max(0, Number(used) || 0);
  const raw = (u / cap) * 100;
  const pct = Math.min(100, Math.round(raw));
  const over = raw >= 100;
  const near = raw >= 80;
  return { pct, near, over, tone: over ? 'bad' : near ? 'warn' : 'ok' };
}

/** "Oct 9, 2026" — unambiguous everywhere (the bare toLocaleDateString gave 10/9/2026, which reads as 10 September in most of the world). */
export function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
