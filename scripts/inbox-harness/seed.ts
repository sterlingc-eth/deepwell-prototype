// Synthetic inbox for the Inbox redesign harness (dev-only, never shipped): a few hundred papers in every state the
// Inbox sorts, with customers and link suggestions, so the screen can be shot and clicked at a realistic size.
import { recomputeIssues, useGraph } from '../../src/core/entityGraph';
import { hvacSchema } from '../../src/domains/hvac/schema';
import type { Doc, Entity, ExtractedField } from '../../src/core/types';

const first = ['Maria', 'James', 'Priya', 'Tom', 'Elena', 'Carlos', 'Aisha', 'Ben', 'Nina', 'Omar', 'Grace', 'Luis', 'Hana', 'Dev', 'Rosa'];
const last = ['Lopez', 'Patel', 'Roberts', 'Nguyen', 'Walsh', 'Ibarra', 'Keller', 'Molina', 'Bishop', 'Calloway', 'Escobar', 'Tran', 'Ruiz', 'Delgado', 'Mata'];
const streets = ['W Palo Dr', 'N Aspen Way', 'E Mesquite Row', 'S Limestone Dr', 'Bluebonnet Ct', 'Copper Ln'];

const f = (name: string, value: string, confidence = 0.95): ExtractedField => ({ name, value, confidence, location: { page: 1, field: name } });

export interface SeedOptions { total?: number }

/** Fills the graph with `total` papers (default 400) mixed across the states the Inbox sorts. Deterministic. */
export function seedInbox(opts: SeedOptions = {}) {
  const total = opts.total ?? 400;
  const entities: Entity[] = [];
  for (let i = 0; i < 60; i++) {
    const name = `${first[i % first.length]} ${last[(i * 7) % last.length]}${i >= 15 ? ` ${Math.floor(i / 15) + 1}` : ''}`;
    entities.push({ id: `cust-${i}`, type: 'customer', fields: { name, customer_name: name, type: 'Residential' } });
  }
  const batches = { b1: { id: 'b1', name: 'Drive import · Sonoran Comfort Air', source: 'drive', dateRange: { from: new Date('2026-09-01'), to: new Date('2026-10-20') }, createdAt: new Date('2026-10-20'), createdBy: 'You', documentIds: [] as string[] } };
  const docs: Doc[] = [];
  const mk = (n: number, o: Partial<Doc> & { filename: string }): Doc => {
    const d = recomputeIssues({
      id: `d${String(n).padStart(4, '0')}`, fileType: 'pdf', pages: 1, batchId: 'b1', source: 'drive',
      receivedAt: new Date(Date.UTC(2026, 9, 20, 12) - n * 3_600_000), typeId: 'invoice', stage: 'linked',
      extracted: [], linkedEntityIds: [], linkConfidence: 0, issues: [], preview: 'text', ...o,
    } as Doc, hvacSchema);
    docs.push(d);
    batches.b1.documentIds.push(d.id);
    return d;
  };
  // Shares of the total: 22% one-click customer, 5% two possible customers, 15% no customer guess, 20% ready, 17% missing info,
  // 4% pick a type, 5% hard to read, 2% check a value, 3% set aside (VOID), 7% already checked.
  const share = (p: number) => Math.round(total * p);
  const plan: [string, number][] = [
    ['confirm', share(0.22)], ['two', share(0.05)], ['nolink', share(0.15)], ['ready', share(0.2)], ['missing', share(0.17)],
    ['type', share(0.04)], ['unread', share(0.05)], ['suspect', share(0.02)], ['void', share(0.03)], ['done', share(0.07)],
  ];
  let n = 0;
  for (const [kind, count] of plan) {
    for (let i = 0; i < count; i++) {
      n++;
      const c = n % entities.length;
      const cn = entities[c]!.fields.name as string;
      const addr = `${1000 + ((n * 37) % 8000)} ${streets[n % streets.length]}, Mesa AZ`;
      const money = String(120 + ((n * 53) % 2400)) + '.00';
      const date = `2026-0${1 + (n % 9)}-${String(1 + (n % 27)).padStart(2, '0')}`;
      const wo = [f('service_address', addr), f('service_date', date), f('customer_name', cn)];
      switch (kind) {
        case 'confirm': mk(n, { filename: `WO-${4400 + n} ${cn.split(' ')[1]}.pdf`, typeId: 'work-order', stage: 'extracted', extracted: wo, linkSuggestionIds: [`cust-${c}`], ...(n % 2 === 0 ? { linkSuggestionStrongIds: [`cust-${c}`] } : {}) }); break;
        case 'two': mk(n, { filename: `WO-${4400 + n} Unit B.pdf`, typeId: 'work-order', stage: 'extracted', extracted: wo, linkSuggestionIds: [`cust-${c}`, `cust-${(c + 1) % entities.length}`] }); break;
        case 'nolink': mk(n, { filename: `Service ticket ${n} ${addr.split(',')[0]}.pdf`, typeId: 'work-order', stage: 'extracted', extracted: [f('service_address', addr), f('invoice_number', `WO-${n}`)] }); break;
        case 'ready': mk(n, { filename: `Invoice INV-${9000 + n} ${cn.split(' ')[1]}.pdf`, extracted: [f('customer_name', cn), f('service_date', date), f('cost', money), f('invoice_number', `INV-${9000 + n}`)], linkedEntityIds: [`cust-${c}`], linkConfidence: 0.95, completeness: { type: 'invoice', required: [], present: [], missing: [], minConfidence: 0.9, complete: true } }); break;
        case 'missing': mk(n, { filename: `Invoice scan ${n}.pdf`, extracted: n % 3 ? [f('customer_name', cn), f('service_date', date)] : [f('customer_name', cn), f('cost', money)], linkedEntityIds: [`cust-${c}`], linkConfidence: 0.9 }); break;
        case 'type': mk(n, { filename: `IMG_${2000 + n}.jpg`, typeId: 'other', stage: 'received', fileType: 'image', extracted: [] }); break;
        case 'unread': mk(n, { filename: `Scan ${n} (blurry).pdf`, typeId: 'invoice', stage: 'received', extracted: [] }); break;
        case 'suspect': {
          const d = mk(n, { filename: `Invoice INV-${9500 + n} ${cn.split(' ')[1]}.pdf`, extracted: [f('customer_name', cn), f('service_date', date), f('cost', money)], linkedEntityIds: [`cust-${c}`], linkConfidence: 0.9 });
          d.issues = [...d.issues, { kind: 'suspect-value', field: 'cost', value: money, rule: 'total-mismatch', reason: 'The page prints a different total.', quote: 'Amount due $1,284.00', page: 1 }];
          break;
        }
        case 'void': mk(n, { filename: `Invoice ${24000 + n} - ${cn.split(' ')[1]} VOID.pdf`, extracted: [f('customer_name', cn), f('cost', money)] }); break;
        case 'done': mk(n, { filename: `Invoice INV-${8000 + n}.pdf`, stage: 'verified', verifiedBy: 'You', verifiedAt: new Date('2026-10-18'), extracted: [f('customer_name', cn), f('service_date', date), f('cost', money)], linkedEntityIds: [`cust-${c}`], linkConfidence: 1 }); break;
      }
    }
  }
  useGraph.getState().seed(hvacSchema, entities, docs, Object.values(batches) as never, []);
  return { total: docs.length, plan };
}
