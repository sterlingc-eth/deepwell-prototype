/** In-memory store with the same interface as store.js, for the stub-provider verify script. Tenant-scoped by construction. */
export function createMemoryStore() {
  const links = new Map(), items = new Map(), events = new Map();
  let email = null, seq = 0;
  const k = (l, r) => `${l}|${r}`;
  const store = {
    _links: links, _items: items,
    addLink: (l) => { const row = { id: `L${++seq}`, status: "active", cursor: {}, mapping: {}, imported_total: 0, lease_until: null, ...l }; links.set(row.id, row); return row; },
    listLinks: async () => [...links.values()].filter((l) => l.status !== "disconnected"),
    getLink: async (id) => links.get(id) ?? null,
    setFolder: async (id, f) => { const l = links.get(id); Object.assign(l, { folder_ref: f.folderRef, folder_name: f.folderName ?? null, status: "active", cursor: {} }); return l; },
    setMapping: async (id, m) => { links.get(id).mapping = m; return links.get(id); },
    setStatus: async (id, status) => { const l = links.get(id); if (l) l.status = status; return l; },
    claim: async (id, leaseMs, now) => { const l = links.get(id); if (!l || l.status !== "active" || (l.lease_until && l.lease_until > now)) return null; l.lease_until = now + leaseMs; return l; },
    saveSecrets: async (id, enc) => { links.get(id).secrets_enc = enc; },
    finish: async (id, f) => { const l = links.get(id); l.lease_until = null; l.status = f.status ?? l.status; l.last_message = f.message ?? null; if (f.cursor) l.cursor = f.cursor; l.imported_total += f.tally?.created ?? 0; },
    getItem: async (lid, ref) => items.get(k(lid, ref)) ?? null,
    itemByProviderHash: async (kind, hash) => [...items.values()].find((i) => i.provider_hash_kind === kind && i.provider_hash === hash && i.document_id && i.state === "imported") ?? null,
    upsertItem: async (it) => {
      const old = items.get(k(it.linkId, it.ref)) ?? {};
      const row = { ...old, link_id: it.linkId, ref: it.ref, filename: it.filename, change_marker: it.marker ?? null, provider_hash: it.providerHash ?? null, provider_hash_kind: it.providerHashKind ?? null,
        content_sha256: it.contentSha256 ?? old.content_sha256 ?? null, document_id: it.documentId ?? old.document_id ?? null, target_folder: it.targetFolder ?? null, state: it.state, note: it.note ?? null };
      items.set(k(it.linkId, it.ref), row); return row;
    },
    markRemoved: async (lid, ref) => { const i = items.get(k(lid, ref)); if (!i || i.state !== "imported") return null; i.state = "removed-in-source"; return i; },
    markReturned: async (lid, ref) => { const i = items.get(k(lid, ref)); if (!i || i.state !== "removed-in-source") return null; i.state = "imported"; return i; },
    getEmail: async () => email,
    saveEmail: async (e) => (email = { ...(email ?? { enabled: true, quarantined_count: 0 }), token_hash: e.tokenHash, token_hint: e.tokenHint, allowed_senders: e.allowedSenders ?? email?.allowed_senders ?? [] }),
    setEmail: async (p) => { if (p.allowedSenders) email.allowed_senders = p.allowedSenders; if (p.enabled !== undefined) email.enabled = p.enabled; return email; },
    recordEmailEvent: async (mid, outcome, files = 0) => { if (events.has(mid)) return false; events.set(mid, { outcome, files, at: Date.now() }); if (outcome === "quarantined" && email) email.quarantined_count++; return true; },
    emailCountSince: async (since) => [...events.values()].filter((e) => e.at > since).length,
  };
  return store;
}
