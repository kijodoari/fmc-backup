#!/usr/bin/env node
/**
 * fmc skin syncer
 * ===============
 * Downloads every published watchface ("skin") from https://fmc.freethinkel.dev/
 * — which is backed by a PocketBase API at the same origin — into this folder:
 *
 *   fmc/skins/<name>-<id>.bin        the flashable watchface file
 *   fmc/previews/<name>-<id>.png     its preview image
 *   fmc/manifest.json                full metadata + sync state
 *
 * Usage:
 *   node sync-skins.mjs             one-shot sync (downloads new + updated skins)
 *   node sync-skins.mjs --watch     keep syncing every 15 minutes
 *   node sync-skins.mjs --watch 5   keep syncing every 5 minutes
 *
 * Re-runs are cheap: already-synced skins are skipped unless they were
 * updated upstream, and skins that get unpublished or deleted upstream are
 * removed locally (tracked via manifest.json). No dependencies, Node 18+.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://fmc.freethinkel.dev';
const SOURCES = {
  list: '/api/collections/watchfaces/records',
  file: (id, filename) => `${BASE}/api/files/watchfaces/${id}/${encodeURIComponent(filename)}`,
  page: (id) => `${BASE}/market/${id}`,
};
const HEADERS = {
  'User-Agent': 'fmc-skin-sync/1.0 (+local user script)',
};
const PER_PAGE = 200;
const CONCURRENCY = 6;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKINS_DIR = path.join(HERE, 'skins');
const PREVIEWS_DIR = path.join(HERE, 'previews');
const MANIFEST_FILE = path.join(HERE, 'manifest.json');

// ---------------------------------------------------------------- helpers

const log = (msg) => {
  const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
  process.stdout.write(`[${ts}] ${msg}\n`);
};

const slug = (name) => {
  const s = String(name ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'skin';
};

const baseName = (wf) => `${slug(wf.name)}-${wf.id}`;

/** Returns list of every published watchface record (handles pagination). */
async function fetchRemoteWatchfaces() {
  const items = [];
  for (let page = 1; ; page++) {
    const url = new URL(SOURCES.list, BASE);
    url.searchParams.set('filter', '(published = true)');
    url.searchParams.set('sort', '-created');
    url.searchParams.set('perPage', String(PER_PAGE));
    url.searchParams.set('page', String(page));
    url.searchParams.set('skipTotal', '1');

    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      throw new Error(`listing failed: HTTP ${res.status} — ${await res.text()}`);
    }
    const data = await res.json();
    items.push(...data.items);
    if (data.items.length < PER_PAGE) return items;
  }
}

/** Download url to file, streaming to disk; returns byte length. */
async function download(url, file) {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(file, buf);
  return buf.length;
}

/** Run an async worker over items with fixed concurrency. */
async function pool(items, worker) {
  let i = 0;
  let failures = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        try {
          await worker(items[idx], idx);
        } catch (err) {
          items[idx]._err = err;
          failures++;
          log(`  ! ${items[idx].label}: ${err.message}`);
        }
      }
    }),
  );
  return failures;
}

/** Delete a file only if it lives inside the given directory (safety guard). */
async function removeTracked(dir, relFile) {
  const abs = path.resolve(HERE, relFile ?? '');
  if (!abs.includes(path.resolve(dir) + path.sep)) return false;
  try {
    await fsp.unlink(abs);
    return true;
  } catch {
    return false;
  }
}

/** Keep only the parts we need from a remote record. */
const compact = (wf) => ({
  id: wf.id,
  name: wf.name || '(unnamed)',
  author: wf.expand?.owner?.name || 'unknown',
  type: wf.type || '',
  downloads: wf.downloads ?? 0,
  created: wf.created,
  updated: wf.updated,
  binFile: wf.bin,
  previewFile: wf.preview,
});

// ---------------------------------------------------------------- sync

async function sync() {
  const t0 = Date.now();
  const remote = await fetchRemoteWatchfaces();
  log(`remote: ${remote.length} published watchfaces`);

  /** @type {Record<string, any>} */
  const prev = fs.existsSync(MANIFEST_FILE)
    ? JSON.parse(await fsp.readFile(MANIFEST_FILE, 'utf8'))
    : { lastSync: null, faces: {} };
  prev.faces ??= {};
  const now = new Date().toISOString();

  const byId = new Map(remote.map((wf) => [wf.id, wf]));
  const fresh = [];
  const changed = [];
  for (const wf of remote) {
    const info = compact(wf);
    const old = prev.faces[wf.id];
    if (!old) fresh.push(info);
    else if (old.updated !== info.updated || old.binFile !== info.binFile || old.previewFile !== info.previewFile) {
      changed.push(info);
    }
  }

  const gone = Object.keys(prev.faces).filter((id) => !byId.has(id));
  let removed = 0;
  for (const id of gone) {
    const old = prev.faces[id];
    if (await removeTracked(SKINS_DIR, old.skinsPath)) removed++;
    if (await removeTracked(PREVIEWS_DIR, old.previewsPath)) removed++;
    delete prev.faces[id];
  }
  if (gone.length) log(`removed ${gone.length} stale local skin(s) (unpublished/deleted upstream)`);

  const wants = [...fresh, ...changed];
  log(`to download: ${fresh.length} new, ${changed.length} updated`);
  let bytes = 0;
  let done = 0;
  await pool(wants, async (info) => {
    info.label = `${info.name}`;
    const stem = baseName(info);
    const binName = `${stem}.bin`;
    const previewName = `${stem}.png`;

    const stored = { ...info, syncedAt: now, skinsPath: `skins/${binName}`, previewsPath: `previews/${previewName}`, urls: { page: SOURCES.page(info.id), bin: SOURCES.file(info.id, info.binFile), preview: SOURCES.file(info.id, info.previewFile) } };
    const nB = await download(stored.urls.bin, path.join(SKINS_DIR, binName));
    bytes += nB;
    let nP = 0;
    if (info.previewFile) {
      nP = await download(stored.urls.preview, path.join(PREVIEWS_DIR, previewName));
      bytes += nP;
    }
    stored.binBytes = nB;
    stored.previewBytes = nP;

    prev.faces[info.id] = stored;
    done++;
    if (done % 25 === 0) log(`  … ${done}/${wants.length} skins done`);
  });

  prev.lastSync = now;
  prev.totals = { faces: remote.length, bytes: Object.values(prev.faces).reduce((n, f) => n + (f.binBytes ?? 0) + (f.previewBytes ?? 0), 0) };
  await fsp.writeFile(MANIFEST_FILE, JSON.stringify(prev, null, 2) + '\n');

  const failed = wants.filter((w) => w._err).length;
  log(
    `done in ${((Date.now() - t0) / 1000).toFixed(1)}s | ` +
      `${fresh.length} new, ${changed.length} updated, ${gone.length} removed, ` +
      `${failed} failed | this run: ${(bytes / 1048576).toFixed(1)} MB | ` +
      `final total: ${remote.length - failed} skins, ${((prev.totals.bytes) / 1048576).toFixed(1)} MB`,
  );
  return { remote: remote.length, fresh: fresh.length, updated: changed.length, removed: gone.length, failed };
}

// ---------------------------------------------------------------- cli

const argv = process.argv.slice(2);
const wsIdx = argv.indexOf('--watch');
const watchMin = wsIdx !== -1 ? Math.max(0.5, Number(argv[wsIdx + 1]) || 15) : null;

for (const dir of [SKINS_DIR, PREVIEWS_DIR]) await fsp.mkdir(dir, { recursive: true });

const runOnce = async () => {
  try {
    await sync();
    return 0;
  } catch (err) {
    log(`sync failed: ${err.message}`);
    return 1;
  }
};

if (watchMin === null) {
  process.exit(await runOnce());
} else {
  const ms = watchMin * 60000;
  log(`watch mode: syncing now, then every ${watchMin} min (Ctrl+C to stop)`);
  process.exitCode = await runOnce();
  for (;;) {
    await new Promise((r) => setTimeout(r, ms));
    process.exitCode = await runOnce();
  }
}
