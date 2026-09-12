import { useMemo, useState } from 'react';
import { ArrowLeft, MessageSquareText } from 'lucide-react';
import { AppShell } from '../components/AppShell';
import { FactGrid } from '../components/FactGrid';
import { SourceList } from '../components/SourceList';
import { DocumentPreview } from '../components/DocumentPreview';
import { WarrantyStatusBadge } from '../components/WarrantyStatusBadge';
import { docsLinkedTo, entitiesOfType, sourcesFor, useGraph } from '../core/entityGraph';
import { dateOf, fmtValue, str } from '../core/answer';
import type { Entity, Fact, SourceRef } from '../core/types';
import { useAppStore } from '../store/appStore';

function entityLabel(e: Entity, labelField: string): string {
  return str(e, labelField) || e.id;
}

/**
 * One screen for any record — property, unit, technician, customer, visit.
 * Everything shown is read from the entity graph, and every field shows the
 * documents behind it, so this is the same truth the Ask screen answers from.
 */
export function EntityScreen() {
  const entityId = useAppStore((s) => s.selectedEntityId);
  const openEntity = useAppStore((s) => s.openEntity);
  const askQuestion = useAppStore((s) => s.askQuestion);
  const setCurrentScreen = useAppStore((s) => s.setCurrentScreen);
  const includeUnverified = useAppStore((s) => s.includeUnverified);
  const graph = useGraph();
  const [preview, setPreview] = useState<SourceRef | null>(null);

  const entity = entityId ? graph.entities[entityId] : undefined;
  const typeSpec = entity ? graph.schema.entityTypes.find((t) => t.id === entity.type) : undefined;

  const facts = useMemo<Fact[]>(() => {
    if (!entity || !typeSpec) return [];
    const out: Fact[] = [];
    for (const f of typeSpec.fields) {
      if (f.kind === 'ref') continue; // refs render as related records below
      const raw = entity.fields[f.key];
      if (raw === null || raw === undefined || raw === '') continue;
      const sources = sourcesFor(graph, entity.id, f.key, true);
      if (!sources.length) continue; // nothing to cite → not shown here either
      out.push({ label: f.label, value: fmtValue(raw), kind: f.kind, sources, entityId: entity.id });
    }
    return out;
  }, [entity, typeSpec, graph]);

  if (!entity || !typeSpec) {
    return (
      <AppShell width="ask">
        <p className="text-ink-2">That record isn't in your records.</p>
        <button type="button" className="dw-btn-tertiary mt-3" onClick={() => setCurrentScreen('ask')}>
          Back to Ask
        </button>
      </AppShell>
    );
  }

  const label = entityLabel(entity, typeSpec.labelField);
  const docOrder = new Map<string, number>();
  const allRefs = facts.flatMap((f) => f.sources);
  for (const s of allRefs) if (!docOrder.has(s.documentId)) docOrder.set(s.documentId, docOrder.size + 1);
  const citation = (ref: SourceRef) => docOrder.get(ref.documentId) ?? 0;

  // Related records
  const related: { title: string; items: Entity[]; labelField: string; extra?: (e: Entity) => string }[] = [];
  const spec = (t: string) => graph.schema.entityTypes.find((x) => x.id === t)?.labelField ?? 'id';
  if (entity.type === 'property') {
    related.push({ title: 'Equipment here', items: entitiesOfType(graph, 'equipment').filter((e) => str(e, 'propertyId') === entity.id), labelField: 'serial', extra: (e) => `${str(e, 'manufacturer')} ${str(e, 'equipmentType')} · ${str(e, 'model')}` });
    related.push({ title: 'Service visits', items: visitsSorted(entitiesOfType(graph, 'service').filter((e) => str(e, 'propertyId') === entity.id)), labelField: 'workPerformed', extra: (e) => `${str(e, 'date')} · ${str(e, 'technicianName')} · ${fmtValue(e.fields['cost'] ?? null)}` });
  }
  if (entity.type === 'equipment') {
    const p = graph.entities[str(entity, 'propertyId')];
    if (p) related.push({ title: 'Location', items: [p], labelField: 'address', extra: (e) => str(e, 'customerName') });
    related.push({ title: 'Service visits', items: visitsSorted(entitiesOfType(graph, 'service').filter((e) => str(e, 'equipmentId') === entity.id)), labelField: 'workPerformed', extra: (e) => `${str(e, 'date')} · ${str(e, 'technicianName')} · ${fmtValue(e.fields['cost'] ?? null)}` });
  }
  if (entity.type === 'technician') {
    related.push({ title: 'Installed', items: entitiesOfType(graph, 'equipment').filter((e) => str(e, 'installedBy') === entity.id), labelField: 'serial', extra: (e) => `${str(e, 'manufacturer')} ${str(e, 'equipmentType')} · ${str(graph.entities[str(e, 'propertyId')], 'address')}` });
    related.push({ title: 'Service visits', items: visitsSorted(entitiesOfType(graph, 'service').filter((e) => str(e, 'technicianId') === entity.id)), labelField: 'workPerformed', extra: (e) => `${str(e, 'date')} · ${str(graph.entities[str(e, 'propertyId')], 'address')} · ${fmtValue(e.fields['cost'] ?? null)}` });
  }
  if (entity.type === 'customer') {
    related.push({ title: 'Properties', items: entitiesOfType(graph, 'property').filter((e) => str(e, 'customerId') === entity.id), labelField: 'address' });
  }
  if (entity.type === 'service') {
    for (const [key, title] of [['propertyId', 'Property'], ['equipmentId', 'Equipment'], ['technicianId', 'Technician']] as const) {
      const e = graph.entities[str(entity, key)];
      if (e) related.push({ title, items: [e], labelField: spec(e.type) });
    }
  }

  const linkedDocs = docsLinkedTo(graph, entity.id);
  const docRefs: SourceRef[] = linkedDocs.map((d) => ({ documentId: d.id, location: { page: 1 } }));

  return (
    <AppShell width="ask">
      <div className="space-y-8">
        <button type="button" onClick={() => setCurrentScreen('ask')} className="dw-btn-tertiary -ml-3">
          <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to Ask
        </button>

        <header className="space-y-3">
          <p className="dw-label">{typeSpec.label}</p>
          <h1 className={entity.type === 'equipment' ? 'font-mono font-semibold text-h1 tracking-wide' : 'text-h1'}>{label}</h1>
          <div className="flex flex-wrap items-center gap-3">
            {entity.type === 'equipment' && <WarrantyStatusBadge warranty={{ warrantyExpiry: dateOf(entity, 'warrantyExpiry') }} />}
            {entity.type === 'property' && <span className="text-ink-2">{str(entity, 'customerName')}</span>}
            <button type="button" className="dw-btn-secondary !min-h-[40px] !py-1.5" onClick={() => askQuestion(label)}>
              <MessageSquareText className="w-4 h-4" aria-hidden="true" /> Ask about this
            </button>
          </div>
          {!includeUnverified && <p className="text-caption text-ink-3">Fields below show every document that mentions them, including unverified ones. Ask answers use verified documents only.</p>}
        </header>

        <FactGrid facts={facts} citation={citation} onOpenSource={setPreview} />

        {related.map((group) => (
          <section key={group.title} aria-label={group.title} className="space-y-2">
            <h2 className="dw-label">
              {group.title} <span className="text-ink-3 normal-case font-normal">· {group.items.length}</span>
            </h2>
            {group.items.length === 0 ? (
              <p className="text-ink-3">None on record.</p>
            ) : (
              <ul className="divide-y divide-line border border-line rounded-lg bg-surface">
                {group.items.map((item) => (
                  <li key={item.id}>
                    <button type="button" onClick={() => openEntity(item.id)} className="w-full text-left px-4 py-3 min-h-touch hover:bg-surface-2 transition-colors duration-quick">
                      <span className={`block ${item.type === 'equipment' ? 'font-mono' : 'font-medium'} text-ink`}>{entityLabel(item, group.labelField)}</span>
                      {group.extra && <span className="block text-body text-ink-3 mt-0.5">{group.extra(item)}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <SourceList sources={docRefs} onOpen={setPreview} title="Documents linked to this record" emptyText="No documents are linked to this record yet." />
      </div>

      {preview && <DocumentPreview documentId={preview.documentId} location={preview.location} onClose={() => setPreview(null)} />}
    </AppShell>
  );
}

function visitsSorted(items: Entity[]): Entity[] {
  return [...items].sort((a, b) => (dateOf(b, 'date')?.getTime() ?? 0) - (dateOf(a, 'date')?.getTime() ?? 0));
}
