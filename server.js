'use strict';
/*
 * StreamFilter — your own Stremio addon with debrid support.
 * Reads torrent results from the source(s) you set, checks them against your
 * debrid service (TorBox, Real-Debrid, AllDebrid, Premiumize), applies your
 * filters and returns instant-play links. Zero dependencies, Node.js 18+.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SERVICES } = require('./debrid');

const PORT = process.env.PORT || 7000;
const VERSION = '2.0.0';
const STREAM_CACHE_MS = 10 * 60 * 1000;
const LINK_CACHE_MS = 60 * 60 * 1000;
const RES_ORDER = ['2160p', '1080p', '720p', '480p', 'unknown'];
const RES_RANK = { '2160p': 4, '1080p': 3, '720p': 2, '480p': 1, unknown: 0 };

const DEFAULTS = {
  addonName: 'StreamFilter',
  service: 'torbox',        // torbox | realdebrid | alldebrid | premiumize
  apiKey: '',
  upstreams: [],            // torrent source manifest URLs
  maxResults: 20,
  maxPerResolution: 0,
  removeUncached: true,
  excludeHDR: false,
  excludeDV: false,
  excludeCam: true,
  resolutions: RES_ORDER.slice(),
  minSizeGB: 0,
  maxSizeGB: 0,
  excludeKeywords: [],
  requireKeywords: [],
  languages: [],
  sortBy: 'quality',        // quality | size | seeders | none
  dedupe: true,
  timeoutMs: 8000,
};

/* ---------------- config ---------------- */

function decodeConfig(str) {
  if (!str) return null;
  try {
    return sanitize(JSON.parse(Buffer.from(str, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function sanitize(raw) {
  const c = { ...DEFAULTS, ...raw };
  const num = (v, d, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : d;
  };
  const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/))
    .map((x) => String(x).trim()).filter(Boolean);
  c.addonName = String(c.addonName || DEFAULTS.addonName).slice(0, 40);
  c.service = SERVICES[c.service] ? c.service : 'torbox';
  c.apiKey = String(c.apiKey || '').trim().slice(0, 200);
  c.upstreams = list(c.upstreams).map(normalizeUpstream).filter(Boolean).slice(0, 10);
  c.maxResults = num(c.maxResults, 20, 0, 500);
  c.maxPerResolution = num(c.maxPerResolution, 0, 0, 500);
  c.minSizeGB = num(c.minSizeGB, 0, 0, 1000);
  c.maxSizeGB = num(c.maxSizeGB, 0, 0, 1000);
  c.timeoutMs = num(c.timeoutMs, 8000, 1000, 30000);
  c.resolutions = list(c.resolutions).filter((r) => RES_ORDER.includes(r));
  if (!c.resolutions.length) c.resolutions = RES_ORDER.slice();
  c.excludeKeywords = list(c.excludeKeywords).map((k) => k.toLowerCase());
  c.requireKeywords = list(c.requireKeywords).map((k) => k.toLowerCase());
  c.languages = list(c.languages).map((k) => k.toLowerCase());
  c.sortBy = ['quality', 'size', 'seeders', 'none'].includes(c.sortBy) ? c.sortBy : 'quality';
  for (const k of ['removeUncached', 'excludeHDR', 'excludeDV', 'excludeCam', 'dedupe']) c[k] = Boolean(c[k]);
  return c;
}

function normalizeUpstream(u) {
  let s = String(u).trim();
  if (!s) return null;
  s = s.replace(/^stremio:\/\//i, 'https://');
  if (!/^https?:\/\//i.test(s)) return null;
  return s.replace(/\/manifest\.json.*$/i, '').replace(/\/+$/, '');
}

function manifest(config) {
  return {
    id: 'community.streamfilter',
    version: VERSION,
    name: config ? config.addonName : DEFAULTS.addonName,
    description: 'Your own debrid streams with your filters: HDR, resolution, size, result count, cached-only and more.',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: !config },
  };
}

/* ---------------- parsing ---------------- */

const RE = {
  hdr: /\bHDR(?:10)?(?:\+|plus)?(?![a-z0-9])/i,
  dv: /\b(?:DV|DoVi|Dolby[ ._-]?Vision)\b/i,
  cam: /\b(?:CAM|CAMRip|HD-?CAM|TS|HD-?TS|TELESYNC|TC|TELECINE|PDVD)\b/i,
  r2160: /\b(?:2160p|4k|uhd)\b/i,
  r1080: /\b(?:1080p|1440p|fhd)\b/i,
  r720: /\b(?:720p|hd)\b/i,
  r480: /\b(?:480p|576p|360p|sd|dvdrip)\b/i,
  size: /(\d+(?:[.,]\d+)?)\s*(TB|GB|GiB|MB|MiB)\b/i,
  seeders: /👤\s*(\d+)/,
  uncachedTag: /download\]|⬇|⏳|\buncached\b/i,
  cachedTag: /\[[a-z]{2,}\+\]|⚡/i,
};

function parseStream(s) {
  const bh = s.behaviorHints || {};
  const text = [s.name, s.title, s.description, bh.filename].filter(Boolean).join('\n');
  let resolution = 'unknown';
  if (RE.r2160.test(text)) resolution = '2160p';
  else if (RE.r1080.test(text)) resolution = '1080p';
  else if (RE.r720.test(text)) resolution = '720p';
  else if (RE.r480.test(text)) resolution = '480p';

  let sizeGB = 0;
  if (bh.videoSize) sizeGB = bh.videoSize / 1024 ** 3;
  else {
    const m = text.match(RE.size);
    if (m) {
      const n = parseFloat(m[1].replace(',', '.'));
      const unit = m[2].toUpperCase();
      sizeGB = unit === 'TB' ? n * 1024 : unit.startsWith('G') ? n : n / 1024;
    }
  }
  const seed = text.match(RE.seeders);
  const hash = s.infoHash ? String(s.infoHash).toLowerCase() : null;
  // the filename is usually the last line of Torrentio-style titles
  const firstLine = String(s.title || s.description || '').split('\n')[0].trim();
  return {
    lower: text.toLowerCase(),
    resolution,
    hdr: RE.hdr.test(text),
    dv: RE.dv.test(text),
    cam: RE.cam.test(text),
    sizeGB,
    seeders: seed ? parseInt(seed[1], 10) : 0,
    hash,
    filename: bh.filename || (/\.[a-z0-9]{2,4}$/i.test(firstLine) ? firstLine : ''),
    // for streams that already carry a link (no hash): read cached tags from the name
    cached: hash ? null : RE.cachedTag.test(s.name || '') ? true : RE.uncachedTag.test(s.name || '') ? false : null,
    key: hash ? `${hash}:${s.fileIdx ?? ''}` : s.url || text,
  };
}

/* ---------------- sources ---------------- */

const nameCache = new Map();

async function fetchJSON(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': `StreamFilter/${VERSION}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function upstreamName(base, timeoutMs) {
  if (nameCache.has(base)) return nameCache.get(base);
  let name;
  try { name = (await fetchJSON(`${base}/manifest.json`, timeoutMs)).name; } catch { /* ignore */ }
  name = name || new URL(base).hostname;
  nameCache.set(base, name);
  return name;
}

async function gatherStreams(c, type, id) {
  const results = await Promise.allSettled(c.upstreams.map(async (base) => {
    const [data, name] = await Promise.all([
      fetchJSON(`${base}/stream/${type}/${encodeURIComponent(id).replace(/%3A/gi, ':')}.json`, c.timeoutMs),
      upstreamName(base, c.timeoutMs),
    ]);
    return (data.streams || []).map((s) => ({ s, source: name }));
  }));
  const all = [];
  const report = [];
  results.forEach((r, i) => {
    const host = new URL(c.upstreams[i]).hostname;
    if (r.status === 'fulfilled') {
      all.push(...r.value);
      report.push({ source: host, ok: true, results: r.value.length, torrents: r.value.filter((x) => x.s.infoHash).length });
    } else {
      const msg = r.reason && (r.reason.name === 'TimeoutError' ? 'timed out' : r.reason.message);
      console.warn(`[source] ${host} failed: ${msg}`);
      report.push({ source: host, ok: false, error: msg });
    }
  });
  return { all, report };
}

/* ---------------- pipeline ---------------- */

function applyFilters(items, c) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.s.infoHash && !it.s.url) continue; // nothing playable
    const p = parseStream(it.s);
    if (c.dedupe) {
      if (seen.has(p.key)) continue;
      seen.add(p.key);
    }
    if (c.excludeHDR && p.hdr) continue;
    if (c.excludeDV && p.dv) continue;
    if (c.excludeCam && p.cam) continue;
    if (!c.resolutions.includes(p.resolution)) continue;
    if (c.minSizeGB && p.sizeGB && p.sizeGB < c.minSizeGB) continue;
    if (c.maxSizeGB && p.sizeGB && p.sizeGB > c.maxSizeGB) continue;
    if (c.excludeKeywords.some((k) => p.lower.includes(k))) continue;
    if (c.requireKeywords.length && !c.requireKeywords.every((k) => p.lower.includes(k))) continue;
    if (c.languages.length && !c.languages.some((k) => p.lower.includes(k))) continue;
    out.push({ ...it, p });
  }
  const cmp = {
    quality: (a, b) => RES_RANK[b.p.resolution] - RES_RANK[a.p.resolution] || b.p.sizeGB - a.p.sizeGB,
    size: (a, b) => b.p.sizeGB - a.p.sizeGB,
    seeders: (a, b) => b.p.seeders - a.p.seeders || RES_RANK[b.p.resolution] - RES_RANK[a.p.resolution],
  }[c.sortBy];
  if (cmp) out.sort(cmp);
  return out;
}

async function markCached(list, c) {
  const svc = SERVICES[c.service];
  const hashes = [...new Set(list.filter((x) => x.p.hash).map((x) => x.p.hash))].slice(0, 200);
  if (!svc.canCheck) return { ok: true, note: `${svc.label} can't check the cache ahead of time` };
  if (!hashes.length) return { ok: true, note: 'nothing to check' };
  try {
    const cached = await svc.check(c.apiKey, hashes);
    for (const x of list) if (x.p.hash && hashes.includes(x.p.hash)) x.p.cached = cached.has(x.p.hash);
    return { ok: true, checked: hashes.length, cached: cached.size };
  } catch (e) {
    console.warn(`[${svc.label}] cache check failed: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function runPipeline(c, type, id, base, cfgStr) {
  const { all, report } = await gatherStreams(c, type, id);
  const filtered = applyFilters(all, c);
  const cache = await markCached(filtered, c);
  const limited = applyLimits(filtered, c);
  return {
    streams: toStremio(limited, c, base, cfgStr, id),
    debug: {
      sources: report,
      fromSources: all.length,
      afterFilters: filtered.length,
      debridCheck: cache,
      final: limited.length,
    },
  };
}

function applyLimits(list, c) {
  let out = c.removeUncached ? list.filter((x) => x.p.cached !== false) : list;
  if (c.maxPerResolution) {
    const counts = {};
    out = out.filter((x) => (counts[x.p.resolution] = (counts[x.p.resolution] || 0) + 1) <= c.maxPerResolution);
  }
  return c.maxResults ? out.slice(0, c.maxResults) : out;
}

function toStremio(list, c, base, cfgStr, id) {
  const svc = SERVICES[c.service];
  const [, season, episode] = id.split(':');
  const se = season && episode ? `${season}:${episode}` : '-';
  return list.map(({ s, source, p }) => {
    const mark = p.cached === true ? '⚡' : p.cached === false ? '⏳' : '❔';
    const tags = [p.resolution === 'unknown' ? '?' : p.resolution === '2160p' ? '4K' : p.resolution];
    if (p.dv) tags.push('DV');
    if (p.hdr) tags.push('HDR');
    const desc = (s.description || s.title || '').trim();
    const text = `${desc ? `${desc}\n` : ''}🔗 ${source}`;
    const out = {
      name: `${c.addonName} [${svc.short}${mark}]\n${tags.join(' ')}`,
      description: text,
      title: text,
      behaviorHints: { ...(s.behaviorHints || {}), bingeGroup: `streamfilter|${p.resolution}|${p.hdr ? 'hdr' : 'sdr'}` },
    };
    if (p.hash) {
      const file = encodeURIComponent(p.filename || 'video');
      out.url = `${base}/${cfgStr}/play/${p.hash}/${s.fileIdx ?? '-'}/${se}/${file}`;
    } else {
      out.url = s.url;
    }
    return out;
  });
}

/* ---------------- caches ---------------- */

function makeCache(ttl, max = 1000) {
  const m = new Map();
  return {
    get(k) {
      const v = m.get(k);
      if (v && Date.now() - v.t < ttl) return v.data;
      m.delete(k);
      return undefined;
    },
    set(k, data) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { t: Date.now(), data });
    },
  };
}
const streamCache = makeCache(STREAM_CACHE_MS, 500);
const linkCache = makeCache(LINK_CACHE_MS, 2000);
const inflight = new Map();

/* ---------------- http ---------------- */

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function baseUrl(req) {
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0] || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
}

const CONFIG_HTML = fs.readFileSync(path.join(__dirname, 'configure.html'), 'utf8');
const page = (cfg) => CONFIG_HTML.replace('__DEFAULTS__', JSON.stringify(cfg));

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  try {
    // setup page
    if (!parts.length || (parts.length === 1 && parts[0] === 'configure')) {
      return send(res, 200, page(DEFAULTS), 'text/html; charset=utf-8');
    }
    if (parts.length === 2 && parts[1] === 'configure') {
      return send(res, 200, page(decodeConfig(parts[0]) || DEFAULTS), 'text/html; charset=utf-8');
    }
    if (parts.length === 1 && parts[0] === 'manifest.json') return send(res, 200, manifest(null));

    const cfgStr = parts[0];
    const c = decodeConfig(cfgStr);
    if (!c) return send(res, 400, { error: 'Invalid config' });

    // manifest
    if (parts.length === 2 && parts[1] === 'manifest.json') return send(res, 200, manifest(c));

    // streams: /:cfg/stream/:type/:id.json
    if (parts[1] === 'stream' && parts.length === 4 && /^(movie|series)$/.test(parts[2])) {
      const type = parts[2];
      const id = decodeURIComponent(parts[3].replace(/\.json$/, ''));
      const key = `${cfgStr}|${type}|${id}`;
      let streams = streamCache.get(key);
      if (!streams) {
        const out = await runPipeline(c, type, id, baseUrl(req), cfgStr);
        streams = out.streams;
        if (streams.length) streamCache.set(key, streams);
        else {
          // show why nothing came back, right inside Stremio
          const d = out.debug;
          const failed = d.sources.find((x) => !x.ok);
          const why = failed ? `Source ${failed.source} failed: ${failed.error}`
            : !d.fromSources ? 'Your source returned no results for this title'
            : !d.afterFilters ? 'Your filters removed every result'
            : d.debridCheck.ok === false ? `${SERVICES[c.service].label} error: ${d.debridCheck.error}`
            : 'Nothing cached on your debrid service for this title';
          streams = [{
            name: `${c.addonName}\n⚠️`,
            description: `${why}\nTap to open your settings`,
            title: `${why}\nTap to open your settings`,
            externalUrl: `${baseUrl(req)}/${cfgStr}/configure`,
          }];
        }
      }
      return send(res, 200, { streams }, undefined, { 'Cache-Control': streams[0]?.externalUrl ? 'no-store' : 'max-age=600' });
    }

    // test: /:cfg/test/:type/:id
    if (parts[1] === 'test' && parts.length === 4 && /^(movie|series)$/.test(parts[2])) {
      const out = await runPipeline(c, parts[2], decodeURIComponent(parts[3]), baseUrl(req), cfgStr);
      return send(res, 200, { ...out.debug, sample: out.streams.slice(0, 5).map((x) => x.name.replace('\n', ' ')) }, undefined, { 'Cache-Control': 'no-store' });
    }

    // play: /:cfg/play/:hash/:fileIdx/:se/:filename
    if (parts[1] === 'play' && parts.length >= 5) {
      const hash = parts[2].toLowerCase();
      if (!/^[a-f0-9]{40}$/.test(hash)) return send(res, 400, 'Bad hash', 'text/plain');
      const [season, episode] = (parts[4] || '-').split(':');
      const hint = {
        filename: parts[5] ? decodeURIComponent(parts[5]) : '',
        season: season && season !== '-' ? Number(season) : null,
        episode: episode ? Number(episode) : null,
      };
      if (hint.filename === 'video') hint.filename = '';
      const svc = SERVICES[c.service];
      const lkey = `${c.service}|${c.apiKey}|${hash}|${parts[3]}|${parts[4]}`;
      let link = linkCache.get(lkey);
      if (!link) {
        if (!inflight.has(lkey)) {
          inflight.set(lkey, svc.resolve(c.apiKey, hash, hint).finally(() => inflight.delete(lkey)));
        }
        try {
          link = await inflight.get(lkey);
          linkCache.set(lkey, link);
        } catch (e) {
          console.warn(`[${svc.label}] ${hash}: ${e.message}`);
          const msg = e.code === 'DOWNLOADING'
            ? `Not cached on ${svc.label} yet. It has started downloading; try again in a few minutes.`
            : `${svc.label} couldn't play this: ${e.message}`;
          return send(res, e.code === 'DOWNLOADING' ? 503 : 502, msg, 'text/plain; charset=utf-8');
        }
      }
      return send(res, 302, '', 'text/plain', { Location: link, 'Cache-Control': 'no-store' });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { streams: [] });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`StreamFilter running → http://127.0.0.1:${PORT}`));
}

module.exports = { server, applyFilters, parseStream, sanitize };
