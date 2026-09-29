// Fake DeepWell backend for the full-App QA harness (scripts/verify-app-qa.mjs). Installed with
// Playwright's page.route on **/api/**. Scenario knobs: docs/customers count, billing status,
// fail:{status, match} to force an error on matching requests, offline:true to abort every API call.
const iso = (d) => new Date(d).toISOString();
export const NOW = Date.now();
const day = 86400000;

export function makeData({ docs = 12, customers = 6, longNames = false } = {}) {
  const custRows = [];
  const names = ['Harbor Point Apartments', 'Carol Rios', 'Desert Sky Dental', 'Mesa Pines HOA', 'The Nguyens', 'Tempe Family Pharmacy'];
  for (let i = 0; i < customers; i++) {
    const base = names[i % names.length];
    const name = longNames && i === 0
      ? 'Harbor Point Luxury Apartments Homeowners and Residents Association of Greater Phoenix Metropolitan Area LLC'
      : customers > names.length ? `${base} ${i}` : base;
    custRows.push({
      id: `33333333-3333-4333-8333-${String(i + 1).padStart(12, '0')}`,
      customerNumber: `C-${String(i + 1).padStart(5, '0')}`,
      name,
      serviceAddress: longNames && i === 0 ? '5600 West Camelback Road Building C Suite 1200 Unit 14B Upper Level North Wing' : `${1000 + i} N ${20 + (i % 30)}th St`,
      city: 'Mesa', phone: '480-555-01' + String(i % 100).padStart(2, '0'), email: `c${i}@example.com`,
      documentCount: 2, equipmentCount: 1, lastActivity: '2026-09-01', warrantyAlerts: i % 3 === 0 ? 1 : 0,
      alerts: { expiring: i % 3 === 0 ? 1 : 0, expired: 0 }, mergedInto: null,
    });
  }
  const docRows = [];
  const browse = [];
  for (let i = 0; i < docs; i++) {
    const c = custRows[i % Math.max(customers, 1)];
    const id = `44444444-4444-4444-8444-${String(i + 1).padStart(12, '0')}`;
    const verified = i % 4 !== 0;
    docRows.push({ id, original_filename: `work-order-${i}.pdf`, document_type: 'service-ticket', stage: verified ? 'verified' : 'read', created_at: iso(NOW - i * day), content_type: 'application/pdf', page_count: 2, verified_by: verified ? 'ai' : null });
    browse.push({
      id, filename: `work-order-${i}.pdf`, displayName: null, documentType: 'service-ticket', stage: verified ? 'verified' : 'read',
      stageBucket: verified ? 'verified' : 'needs-review', verifiedBy: verified ? 'ai' : null, uploadedBy: null, createdAt: iso(NOW - i * day),
      serviceDate: '2026-06-12', customerId: c?.id ?? null, customerName: c?.name ?? null, siteAddress: c?.serviceAddress ?? null, technician: null,
      brand: 'Trane', warrantyExpiry: '2029-03-15', warrantyBucket: 'active', amount: null, balanceDue: null, moneyStatus: null, hasMoney: false, audience: 'customer',
    });
  }
  return { custRows, docRows, browse };
}

const billing = (status, extra = {}) => ({
  plan: status === 'none' ? null : 'solo', status, trialEndsAt: status === 'trialing' ? iso(NOW + 10 * day) : null,
  currentPeriodEnd: iso(NOW + 20 * day), cancelAtPeriodEnd: false,
  limits: { technicians: 1, documentsStored: 25000, pagesPerMonth: 750, asksPerMonth: 3000 },
  usage: { documentsStored: 12, pagesThisMonth: 40, asksThisMonth: 3, resetsOn: iso(NOW + 20 * day) }, ...extra,
});

export async function installBackend(page, opts = {}) {
  const o = { docs: 12, customers: 6, billing: 'active', fail: null, offline: false, delayMs: 0, ...opts };
  const d = makeData(o);
  const log = [];
  page.__apiLog = log;
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    let body = {};
    try { body = JSON.parse(req.postData() || '{}'); } catch { /* not json */ }
    const action = body.action || url.searchParams.get('action') || '';
    log.push(`${req.method()} ${p}${action ? ' ' + action : ''}`);
    if (o.offline) return route.abort('internetdisconnected');
    if (o.fail && (!o.fail.match || `${p} ${action}`.match(o.fail.match))) {
      const f = o.fail;
      if (f.html) return route.fulfill({ status: f.status, contentType: 'text/html', body: '<html>Server Error</html>' });
      return json(route, { error: f.message || `qa forced ${f.status}`, url: f.url }, f.status);
    }
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    const ok = (b) => json(route, b);
    if (p === '/api/records') {
      switch (action) {
        case 'bootstrap': return ok({ billing: billing(o.billing), notifications: { items: [], unreadCount: o.unread ?? 0 }, records: { rows: d.docRows.slice(0, 50), total: d.docRows.length } });
        case 'listDocuments': return ok(d.docRows);
        case 'listEntities': return ok([]);
        case 'listExtractionsByDocuments': return ok([]);
        case 'browseDocuments': {
          const f = body.filters || {};
          let rows = d.browse;
          if (f.q) rows = rows.filter((r) => `${r.customerName} ${r.filename}`.toLowerCase().includes(String(f.q).toLowerCase()));
          if (f.stageBucket) rows = rows.filter((r) => r.stageBucket === f.stageBucket);
          const start = f.cursor ? Number(f.cursor) : 0; const limit = f.limit || 50;
          const page_ = rows.slice(start, start + limit);
          return ok({ rows: page_, total: rows.length, hasMore: start + limit < rows.length, nextCursor: start + limit < rows.length ? String(start + limit) : null, facets: [], sort: f.sort || 'upload-date', limit });
        }
        default: return ok({});
      }
    }
    if (p === '/api/review') {
      if (action === 'listLinks') return ok({ links: [] });
      if (action === 'listCorrections') return ok({ corrections: [] });
      if (action === 'remindersList' || action === 'extractReminders') return ok({ reminders: [] });
      return ok({});
    }
    if (p === '/api/document-status') return ok({ documents: [] });
    if (p === '/api/billing') return ok(action === 'status' ? billing(o.billing) : {});
    if (p === '/api/v1/customers') return ok({ customers: d.custRows, duplicates: [], possibleDuplicates: [] });
    if (p === '/api/v1/customer') {
      const ref = url.searchParams.get('id') || url.searchParams.get('number');
      const c = d.custRows.find((x) => x.id === ref || x.customerNumber === ref) || d.custRows[0];
      if (!c) return json(route, { error: 'Customer not found' }, 404);
      return ok({ customer: { ...c, notes: null, billingAddress: null, formerNumbers: [] }, equipment: [], documents: [], timeline: [], duplicates: [], alertCount: 0 });
    }
    if (p === '/api/account') {
      if (action === 'notifications') return ok({ items: [], unreadCount: o.unread ?? 0 });
      if (action === 'insights') return ok({ items: o.insights || [], total: (o.insights || []).length, generatedAt: iso(NOW), cached: false });
      if (action === 'followups') return ok({ followups: [], items: [] });
      if (action === 'intake') return ok({ items: [], queue: [], pending: [] });
      return ok({});
    }
    if (p === '/api/merge-tenant') return ok({ moved: {} });
    if (p === '/api/ask') return ok({});
    return ok({});
  });
  return d;
}
