/**
 * R34 test transport stub. Preload with `node --import ./scripts/lib/sentry-sink.mjs <script>`.
 * Replaces https/http `request` and global `fetch` for any host that looks like Sentry with a fake that answers
 * 200 and RECORDS the call (never touches the network); every other host passes through untouched. On exit the
 * recorded calls are written as JSON to $R34_SINK_FILE, so scripts/verify-r34-telemetry.mjs can assert that a
 * run with a (fake) SENTRY_DSN made ZERO Sentry sends — or, as a positive control, at least one.
 */
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";

const hits = [];
const looksSentry = (target) => {
  try {
    const s = typeof target === "string" ? target : target instanceof URL ? target.href : `${target?.hostname ?? ""} ${target?.host ?? ""} ${target?.href ?? ""} ${target?.path ?? ""}`;
    return /sentry/i.test(s);
  } catch {
    return false;
  }
};

function fakeRequest(args, hit) {
  const cb = args.find((a) => typeof a === "function");
  const req = new EventEmitter();
  req.setTimeout = () => req;
  req.destroy = () => req;
  const note = (chunk) => {
    if (chunk == null || typeof chunk === "function") return;
    const text = Buffer.from(chunk).toString("utf8");
    // Envelope item headers: {"type":"event"} / {"type":"client_report"} / {"type":"session"} ...
    for (const m of text.matchAll(/"type":"([a-z_]+)"\},?\s*\n?/g)) (hit.items ??= []).push(m[1]);
  };
  req.write = (chunk) => { note(chunk); return true; };
  req.end = (chunk) => {
    note(chunk);
    setImmediate(() => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      res.setEncoding = () => res;
      res.resume = () => res;
      if (cb) cb(res);
      setImmediate(() => res.emit("end"));
    });
    return req;
  };
  return req;
}

for (const mod of [https, http]) {
  const real = mod.request.bind(mod);
  mod.request = (...args) => {
    if (looksSentry(args[0])) {
      const hit = { via: "request", target: String(args[0]?.hostname ?? args[0]?.href ?? args[0]).slice(0, 80) };
      hits.push(hit);
      return fakeRequest(args, hit);
    }
    return real(...args);
  };
}
const realFetch = globalThis.fetch?.bind(globalThis);
if (realFetch) {
  globalThis.fetch = (input, init) => {
    const target = typeof input === "string" ? input : input?.url ?? String(input);
    if (looksSentry(target)) {
      hits.push({ via: "fetch", target: String(target).slice(0, 80) });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return realFetch(input, init);
  };
}

syncBuiltinESMExports();

process.on("exit", () => {
  const file = process.env.R34_SINK_FILE;
  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify(hits));
    } catch {
      /* best effort */
    }
  }
});
