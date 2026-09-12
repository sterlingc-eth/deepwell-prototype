import { useMemo } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, Copy, GitMerge, Link2 } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { STAGE_LABEL } from '../components/StagePill';
import { docCountsByStage, docsLinkedTo, duplicateDocs, entitiesOfType, gapDocs, openConflicts, unlinkedDocs, useGraph } from '../core/entityGraph';
import { PIPELINE_STAGES } from '../core/types';
import { dateOf, fmtDate, str } from '../core/answer';
import { warrantyStatus } from '../components/WarrantyStatusBadge';
import { EVAL_NOW, EVAL_QUESTIONS } from '../eval/questions';
import { answerSync } from '../services/answerService.mock';
import { useAppStore } from '../store/appStore';

/**
 * Record health, always visible: documents by stage, batches in progress,
 * what still needs a person, per-property completeness, and the live
 * accuracy score on the evaluation set.
 */
export function RecordsScreen() {
  const graph = useGraph();
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const openEntity = useAppStore((s) => s.openEntity);
  const askQuestion = useAppStore((s) => s.askQuestion);

  const counts = docCountsByStage(graph);
  const total = Object.values(graph.docs).length;
  const unlinked = unlinkedDocs(graph).length;
  const gaps = gapDocs(graph).length;
  const conflicts = openConflicts(graph).length;
  const dups = duplicateDocs(graph).length;
  const batches = Object.values(graph.batches);
  const inProgress = batches.filter((b) => b.documentIds.some((id) => graph.docs[id]?.stage !== 'verified'));

  // Live accuracy on the evaluation set, against the current graph
  const evalScore = useMemo(() => {
    let pass = 0;
    for (const c of EVAL_QUESTIONS) {
      const a = answerSync(c.q, graph, { now: EVAL_NOW, includeUnverified: c.includeUnverified ?? false });
      const text = a.text.toLowerCase();
      const facts = a.facts.map((f) => `${f.label} ${f.value}`).join(' | ');
      const ok =
        a.kind === c.expect.kind &&
        (!c.expect.entityId || a.entityId === c.expect.entityId) &&
        (c.expect.text ?? []).every((t) => text.includes(t.toLowerCase())) &&
        (c.expect.facts ?? []).every((f) => facts.includes(f)) &&
        a.facts.every((f) => f.sources.length > 0);
      if (ok) pass += 1;
    }
    return { pass, total: EVAL_QUESTIONS.length };
  }, [graph]);
  const accuracy = Math.round((evalScore.pass / evalScore.total) * 100);

  // Per-property completeness
  const properties = entitiesOfType(graph, 'property').map((p) => {
    const units = entitiesOfType(graph, 'equipment').filter((e) => str(e, 'propertyId') === p.id);
    const visits = entitiesOfType(graph, 'service').filter((s) => str(s, 'propertyId') === p.id);
    const withWarranty = units.filter((e) => dateOf(e, 'warrantyExpiry'));
    const docs = docsLinkedTo(graph, p.id);
    const verifiedDocs = docs.filter((d) => d.stage === 'verified');
    const lastVerified = verifiedDocs.map((d) => d.verifiedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0];
    const issues = docs.filter((d) => d.issues.length).length;
    return { p, units, visits, withWarranty, docs, verifiedDocs, lastVerified, issues };
  });

  const Stat = ({ label, value, sub, tone = 'default', onClick }: { label: string; value: string | number; sub?: string; tone?: 'default' | 'warn' | 'ok'; onClick?: () => void }) => {
    const inner = (
      <>
        <p className="text-caption text-ink-3">{label}</p>
        <p className={['font-display text-h1 mt-1', tone === 'warn' ? 'text-warn-ink dark:text-brass-200' : tone === 'ok' ? 'text-ok-ink dark:text-ok-bg' : ''].join(' ')}>{value}</p>
        {sub && <p className="text-body text-ink-3 mt-1">{sub}</p>}
      </>
    );
    return onClick ? (
      <button type="button" onClick={onClick} className="dw-card p-4 text-left hover:shadow-lift transition-shadow duration-quick">{inner}</button>
    ) : (
      <div className="dw-card p-4">{inner}</div>
    );
  };

  return (
    <AppShell>
      <div className="space-y-10">
        <header>
          <h1>Records</h1>
          <p className="text-ink-2 mt-1">Retrieval quality is decided at intake. This is the state of your records right now.</p>
        </header>

        <section aria-labelledby="health-heading" className="space-y-3">
          <h2 id="health-heading" className="dw-label">Health</h2>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
            <Stat label="Documents" value={total} sub={`${counts.verified} verified · ${Math.round((counts.verified / Math.max(total, 1)) * 100)}%`} />
            <Stat label="Unlinked inbox" value={unlinked} sub={unlinked ? 'Target is zero' : 'Clear'} tone={unlinked ? 'warn' : 'ok'} onClick={() => setCurrentScreen('review')} />
            <Stat label="Required-field gaps" value={gaps} sub={gaps ? 'Blocked at Classified' : 'Clear'} tone={gaps ? 'warn' : 'ok'} onClick={() => setCurrentScreen('review')} />
            <Stat label="Conflicts open" value={conflicts} sub={conflicts ? 'Need a decision' : 'Clear'} tone={conflicts ? 'warn' : 'ok'} onClick={() => setCurrentScreen('review')} />
            <Stat label="Answer accuracy" value={`${accuracy}%`} sub={`${evalScore.pass}/${evalScore.total} on the evaluation set`} tone={accuracy >= 95 ? 'ok' : 'warn'} />
          </div>
          {dups > 0 && (
            <p className="flex items-center gap-2 text-body text-ink-2"><Copy className="w-4 h-4" aria-hidden="true" /> {dups} duplicate{dups === 1 ? '' : 's'} detected and held out of every count. <button type="button" className="underline underline-offset-4" onClick={() => setCurrentScreen('review')}>Merge</button></p>
          )}
        </section>

        <section aria-labelledby="stages-heading" className="space-y-3">
          <h2 id="stages-heading" className="dw-label">Documents by stage</h2>
          <div className="dw-card p-4">
            <div className="h-3 rounded-full overflow-hidden flex bg-surface-2" role="img" aria-label={PIPELINE_STAGES.map((s) => `${STAGE_LABEL[s]} ${counts[s]}`).join(', ')}>
              <span style={{ width: `${(counts.verified / Math.max(total, 1)) * 100}%` }} className="bg-ok" />
              <span style={{ width: `${(counts.linked / Math.max(total, 1)) * 100}%` }} className="bg-warn" />
              <span style={{ width: `${(counts.extracted / Math.max(total, 1)) * 100}%` }} className="bg-info" />
              <span style={{ width: `${((counts.classified + counts.received) / Math.max(total, 1)) * 100}%` }} className="bg-stone-300" />
            </div>
            <dl className="mt-3 grid grid-cols-5 gap-2 text-center">
              {PIPELINE_STAGES.map((s) => (
                <div key={s}>
                  <dt className="text-caption text-ink-3">{STAGE_LABEL[s]}</dt>
                  <dd className="font-display text-h3">{counts[s]}</dd>
                </div>
              ))}
            </dl>
            <p className="text-caption text-ink-3 mt-2">Nothing is answerable until Linked; nothing counts toward accuracy until Verified.</p>
          </div>
        </section>

        <section aria-labelledby="batches-heading" className="space-y-3">
          <h2 id="batches-heading" className="dw-label">Batches in progress · {inProgress.length}</h2>
          {inProgress.length === 0 ? (
            <p className="flex items-center gap-2 text-ink-2"><CheckCircle2 className="w-4 h-4 text-ok" aria-hidden="true" /> Every batch is fully verified.</p>
          ) : (
            <ul className="divide-y divide-line border border-line rounded-lg bg-surface">
              {inProgress.map((b) => {
                const docs = b.documentIds.map((id) => graph.docs[id]).filter((d) => !!d);
                const done = docs.filter((d) => d?.stage === 'verified').length;
                const need = docs.filter((d) => d && (d.issues.length || d.stage === 'received')).length;
                return (
                  <li key={b.id}>
                    <button type="button" onClick={() => setCurrentScreen('ingest')} className="w-full text-left flex items-center gap-3 px-4 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium text-ink truncate">{b.name}</span>
                        <span className="block text-body text-ink-3">{done}/{docs.length} verified · started {fmtDate(b.createdAt)} by {b.createdBy}</span>
                      </span>
                      {need > 0 && <span className="dw-pill-warn"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />{need} need{need === 1 ? 's' : ''} a person</span>}
                      <ChevronRight className="w-4 h-4 text-ink-3" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-labelledby="completeness-heading" className="space-y-3">
          <h2 id="completeness-heading" className="dw-label">Completeness by property</h2>
          <div className="relative overflow-x-auto border border-line rounded-lg bg-surface">
            <table className="w-full text-body-lg">
              <thead className="text-left text-label text-ink-3 uppercase bg-surface-2">
                <tr>
                  <th scope="col" className="px-4 py-2 font-medium">Property</th>
                  <th scope="col" className="px-4 py-2 font-medium">Equipment</th>
                  <th scope="col" className="px-4 py-2 font-medium">Warranty</th>
                  <th scope="col" className="px-4 py-2 font-medium">Service history</th>
                  <th scope="col" className="px-4 py-2 font-medium">Last verified</th>
                  <th scope="col" className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {properties.map(({ p, units, visits, withWarranty, lastVerified, issues }) => {
                  const active = units.filter((e) => ['active', 'expiring'].includes(warrantyStatus(dateOf(e, 'warrantyExpiry')).status)).length;
                  const Mark = ({ ok, text }: { ok: boolean; text: string }) => (
                    <span className={`inline-flex items-center gap-1.5 ${ok ? 'text-ink' : 'text-ink-3'}`}>
                      {ok ? <CheckCircle2 className="w-4 h-4 text-ok" aria-hidden="true" /> : <AlertTriangle className="w-4 h-4 text-warn" aria-hidden="true" />}
                      {text}
                    </span>
                  );
                  return (
                    <tr key={p.id} className="hover:bg-surface-2">
                      <td className="px-4 py-3">
                        <button type="button" onClick={() => openEntity(p.id)} className="text-left font-medium text-ink underline decoration-line-2 underline-offset-4 hover:decoration-forest-700">{str(p, 'address')}</button>
                        <span className="block text-body text-ink-3">{str(p, 'customerName')}{issues ? ` · ${issues} doc${issues === 1 ? ' needs' : 's need'} a person` : ''}</span>
                      </td>
                      <td className="px-4 py-3"><Mark ok={units.length > 0} text={`${units.length} unit${units.length === 1 ? '' : 's'}`} /></td>
                      <td className="px-4 py-3"><Mark ok={withWarranty.length === units.length && units.length > 0} text={units.length ? `${withWarranty.length}/${units.length} on file · ${active} active` : '—'} /></td>
                      <td className="px-4 py-3"><Mark ok={visits.length > 0} text={`${visits.length} event${visits.length === 1 ? '' : 's'}`} /></td>
                      <td className="px-4 py-3 text-ink-2">{lastVerified ? fmtDate(lastVerified) : <span className="text-warn-ink dark:text-brass-200">never</span>}</td>
                      <td className="px-4 py-3 text-right">
                        <button type="button" onClick={() => askQuestion(str(p, 'address'))} className="dw-btn-tertiary !min-h-[36px] !py-1">Ask</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="flex flex-wrap gap-2">
          <button type="button" className="dw-btn-secondary" onClick={() => setCurrentScreen('review')}><Link2 className="w-4 h-4" aria-hidden="true" /> Empty the unlinked inbox</button>
          <button type="button" className="dw-btn-secondary" onClick={() => setCurrentScreen('review')}><GitMerge className="w-4 h-4" aria-hidden="true" /> Resolve conflicts</button>
          <button type="button" className="dw-btn-secondary" onClick={() => setCurrentScreen('ingest')}>Open intake</button>
        </section>
      </div>
    </AppShell>
  );
}
