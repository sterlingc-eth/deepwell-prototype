// A pretend Google for scripts/verify-google-sync.ts. Implements just enough of the OAuth, Drive and Gmail HTTP APIs, in memory,
// behind a fetch-shaped function. No network, no real Google call, no credentials. Counts every call so tests can prove "nothing ran".
import { createHash } from 'node:crypto';

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });
const md5 = (b) => createHash('md5').update(b).digest('hex');
const b64u = (b) => Buffer.from(b).toString('base64url');

export class FakeGoogle {
  constructor() {
    this.calls = []; // every URL requested
    this.files = new Map(); // id -> {id,name,mimeType,parents,content,modifiedTime,trashed}
    this.changes = []; // {fileId, removed}
    this.pageSize = 2; // tiny, to exercise paging
    this.validRefresh = new Set(['rt-A']);
    this.accessTokens = new Set();
    this.tokenCounter = 0;
    this.failures = []; // [{match:/regex/, status, retryAfter, times}]
    this.expireAccessTokens = false;
    this.revoked = [];
    this.email = 'owner@example.com';
    this.grantScope = null; // override scope in the token response
    this.labels = [{ id: 'Label_1', name: 'Invoices', type: 'user' }, { id: 'Label_2', name: 'Receipts', type: 'user' }, { id: 'INBOX', name: 'INBOX', type: 'system' }, { id: 'SPAM', name: 'SPAM', type: 'system' }];
    this.messages = []; // {id, internalDate, from, labelIds, parts:[{partId,filename,mimeType,content,inline,contentId}], body}
    this.nowMs = Date.parse('2026-10-13T12:00:00Z');
    this.downloads = 0;
    this.exports = 0;
  }
  // ---------- Drive fixtures
  addFile(f) {
    const file = { parents: ['root'], mimeType: 'application/pdf', trashed: false, modifiedTime: new Date(this.nowMs).toISOString(), ...f };
    file.content = Buffer.isBuffer(file.content) ? file.content : Buffer.from(String(file.content ?? file.name));
    this.files.set(file.id, file);
    if (file.mimeType !== 'application/vnd.google-apps.folder') this.changes.push({ fileId: file.id });
    return file;
  }
  addFolder(id, name, parents = ['root']) { return this.addFile({ id, name, parents, mimeType: 'application/vnd.google-apps.folder', content: '' }); }
  edit(id, content) { const f = this.files.get(id); f.content = Buffer.from(content); f.modifiedTime = new Date(this.nowMs += 60000).toISOString(); this.changes.push({ fileId: id }); }
  touch(id) { const f = this.files.get(id); f.modifiedTime = new Date(this.nowMs += 60000).toISOString(); this.changes.push({ fileId: id }); }
  trash(id) { this.files.get(id).trashed = true; this.changes.push({ fileId: id }); }
  untrash(id) { this.files.get(id).trashed = false; this.changes.push({ fileId: id }); }
  remove(id) { this.files.delete(id); this.changes.push({ fileId: id, removed: true }); }
  // ---------- Gmail fixtures
  addMessage(m) {
    const msg = { id: `m${this.messages.length + 1}`, internalDate: this.nowMs, from: 'billing@vendor.com', labelIds: [], parts: [], body: 'Hello, this is the private email body text.', ...m };
    this.messages.push(msg);
    return msg;
  }
  failOnce(match, status, retryAfter, times = 1) { this.failures.push({ match, status, retryAfter, times }); }
  callsMatching(re) { return this.calls.filter((u) => re.test(u)).length; }

  fetch = async (url, init = {}) => {
    url = String(url);
    this.calls.push(url);
    for (const f of this.failures) {
      if (f.times > 0 && f.match.test(url)) {
        f.times--;
        const body = f.status === 403 ? { error: { errors: [{ reason: 'rateLimitExceeded' }], message: 'Rate limit' } } : { error: { message: 'fail' } };
        return json(body, f.status, f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {});
      }
    }
    const u = new URL(url);
    const auth = init.headers?.Authorization ?? init.headers?.authorization;
    // ---- OAuth
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token') {
      const p = new URLSearchParams(String(init.body));
      if (p.get('grant_type') === 'authorization_code') {
        if (p.get('code') !== 'good-code') return json({ error: 'invalid_grant', error_description: 'bad code' }, 400);
        const id_token = `x.${b64u(JSON.stringify({ email: this.email }))}.y`;
        return json({ access_token: this.mint(), refresh_token: this.noRefresh ? undefined : 'rt-A', scope: this.grantScope ?? p.get('scope') ?? 'openid email https://www.googleapis.com/auth/drive.file', expires_in: 3600, id_token });
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (!this.validRefresh.has(p.get('refresh_token'))) return json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400);
        return json({ access_token: this.mint(), expires_in: 3600 });
      }
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/revoke') { this.revoked.push(u.searchParams.get('token')); this.validRefresh.delete(u.searchParams.get('token')); return json({}); }
    // everything below needs a live access token
    const token = String(auth ?? '').replace(/^Bearer /, '');
    if (!this.accessTokens.has(token) || this.expireAccessTokens) { this.expireAccessTokens = false; return json({ error: { message: 'Invalid Credentials' } }, 401); }

    if (u.host === 'www.googleapis.com' && u.pathname.startsWith('/drive/v3/')) return this.drive(u);
    if (u.host === 'gmail.googleapis.com') return this.gmail(u);
    return json({ error: { message: 'not found' } }, 404);
  };

  mint() { const t = `at-${++this.tokenCounter}`; this.accessTokens.add(t); return t; }

  meta(f) { return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, trashed: f.trashed, parents: f.parents, size: String(f.content.length), version: '1', ...(f.mimeType.startsWith('application/vnd.google-apps.') ? {} : { md5Checksum: md5(f.content) }) }; }

  drive(u) {
    const path = u.pathname.slice('/drive/v3/'.length);
    if (path === 'changes/startPageToken') return json({ startPageToken: String(this.changes.length) });
    if (path === 'changes') {
      const from = Number(u.searchParams.get('pageToken'));
      const slice = this.changes.slice(from, from + this.pageSize);
      const next = from + this.pageSize;
      const out = { changes: slice.map((c) => ({ fileId: c.fileId, removed: Boolean(c.removed), file: c.removed ? undefined : this.meta(this.files.get(c.fileId)) })) };
      if (next < this.changes.length) out.nextPageToken = String(next); else out.newStartPageToken = String(this.changes.length);
      return json(out);
    }
    if (path === 'files') {
      const q = u.searchParams.get('q') ?? '';
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const foldersOnly = /mimeType = 'application\/vnd.google-apps.folder'/.test(q);
      let list = [...this.files.values()].filter((f) => f.parents.includes(parent) && !f.trashed && (!foldersOnly || f.mimeType === 'application/vnd.google-apps.folder'));
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const page = list.slice(start, start + this.pageSize);
      const out = { files: page.map((f) => (foldersOnly ? { id: f.id, name: f.name } : this.meta(f))) };
      if (start + this.pageSize < list.length) out.nextPageToken = String(start + this.pageSize);
      return json(out);
    }
    const m = /^files\/([^/]+)(\/export)?$/.exec(path);
    if (m) {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return json({ error: { message: 'File not found' } }, 404);
      if (m[2]) { this.exports++; return new Response(Buffer.concat([Buffer.from('%EXPORT:'), f.content]), { status: 200 }); }
      if (u.searchParams.get('alt') === 'media') { this.downloads++; return new Response(f.content, { status: 200, headers: { 'content-length': String(f.content.length) } }); }
      return json(this.meta(f));
    }
    return json({ error: { message: 'unknown' } }, 404);
  }

  gmail(u) {
    const path = u.pathname.replace('/gmail/v1/users/me/', '');
    if (path === 'labels') return json({ labels: this.labels });
    if (path === 'messages') {
      const q = u.searchParams.get('q') ?? '';
      const labelIds = u.searchParams.getAll('labelIds');
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
      const fromList = /from:\(([^)]*)\)/.exec(q)?.[1]?.split(/\s+OR\s+/) ?? null;
      let list = this.messages.filter((m) => m.internalDate >= after && m.parts.length > 0);
      if (labelIds.length) list = list.filter((m) => labelIds.every((l) => m.labelIds.includes(l)));
      if (fromList) list = list.filter((m) => fromList.includes(m.from));
      list = list.sort((a, b) => b.internalDate - a.internalDate);
      const start = Number(u.searchParams.get('pageToken') ?? 0);
      const page = list.slice(start, start + this.pageSize);
      const out = { messages: page.map((m) => ({ id: m.id })) };
      if (start + this.pageSize < list.length) out.nextPageToken = String(start + this.pageSize);
      return json(out);
    }
    let m = /^messages\/([^/]+)$/.exec(path);
    if (m) {
      const msg = this.messages.find((x) => x.id === m[1]);
      if (!msg) return json({ error: { message: 'Not found' } }, 404);
      return json({
        id: msg.id, internalDate: String(msg.internalDate),
        payload: {
          mimeType: 'multipart/mixed', headers: [{ name: 'From', value: msg.from }],
          parts: [
            { partId: '0', mimeType: 'text/plain', filename: '', body: { size: msg.body.length, data: b64u(msg.body) } },
            ...msg.parts.map((p) => ({ partId: p.partId, filename: p.filename, mimeType: p.mimeType ?? 'application/pdf', headers: [...(p.inline ? [{ name: 'Content-Disposition', value: 'inline' }] : []), ...(p.contentId ? [{ name: 'Content-ID', value: p.contentId }] : [])], body: { attachmentId: `att-${msg.id}-${p.partId}`, size: Buffer.from(p.content).length } })),
          ],
        },
      });
    }
    m = /^messages\/([^/]+)\/attachments\/(.+)$/.exec(path);
    if (m) {
      const msg = this.messages.find((x) => x.id === m[1]);
      const p = msg?.parts.find((x) => `att-${msg.id}-${x.partId}` === decodeURIComponent(m[2]));
      if (!p) return json({ error: { message: 'Not found' } }, 404);
      this.downloads++;
      return json({ size: Buffer.from(p.content).length, data: b64u(Buffer.from(p.content)) });
    }
    return json({ error: { message: 'unknown' } }, 404);
  }
}
