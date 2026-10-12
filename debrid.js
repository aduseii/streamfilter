'use strict';
/*
 * Debrid services: check what's cached and turn a torrent hash into a playable link.
 * Each service exposes:
 *   canCheck            – true if it can report cached status before playing
 *   check(key, hashes)  – Set of cached hashes (only when canCheck)
 *   resolve(key, hash, hint) – direct video URL, or throws DebridError
 */

const TB = process.env.TORBOX_API || 'https://api.torbox.app/v1/api';
const RD = process.env.REALDEBRID_API || 'https://api.real-debrid.com/rest/1.0';
const AD = process.env.ALLDEBRID_API || 'https://api.alldebrid.com';
const PM = process.env.PREMIUMIZE_API || 'https://www.premiumize.me/api';
const TIMEOUT = 15000;

const VIDEO = /\.(mkv|mp4|avi|mov|wmv|m4v|ts|m2ts|webm|mpe?g|flv)$/i;

class DebridError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}
const DOWNLOADING = () => new DebridError('DOWNLOADING', 'Not cached yet — your debrid service started downloading it');
const NO_VIDEO = () => new DebridError('NO_VIDEO', 'No playable video file in this torrent');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const magnet = (hash) => `magnet:?xt=urn:btih:${hash}`;
const norm = (s) => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^\p{L}\p{N}]/gu, '');
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

/** Pick the right video file: exact filename → SxxEyy match → largest. Returns the original object. */
function pickFile(files, hint = {}, nameOf = (f) => f.name, sizeOf = (f) => f.size) {
  const vids = files.filter((f) => VIDEO.test(nameOf(f))).sort((a, b) => sizeOf(b) - sizeOf(a));
  if (!vids.length) return null;
  if (hint.filename) {
    const want = norm(hint.filename);
    const hit = vids.find((f) => norm(nameOf(f).split('/').pop()) === want);
    if (hit) return hit;
  }
  if (hint.season != null && hint.episode != null) {
    const s = hint.season, e = hint.episode;
    const re = new RegExp(`s0*${s}[ ._-]*e0*${e}(?!\\d)|(?<!\\d)0*${s}x0*${e}(?!\\d)`, 'i');
    const hit = vids.find((f) => re.test(nameOf(f)));
    if (hit) return hit;
  }
  return vids[0];
}

async function readJSON(res) {
  try { return await res.json(); } catch { return null; }
}

/* ---------------- TorBox ---------------- */

async function tb(key, method, path, { params, json, form } = {}) {
  const q = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${TB}${path}${q}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(json && { 'Content-Type': 'application/json' }) },
    body: json ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const r = await readJSON(res);
  if (!r || !r.success) throw new DebridError(r?.error || `HTTP_${res.status}`, r?.detail);
  return r.data;
}

const torbox = {
  label: 'TorBox', short: 'TB', canCheck: true,
  async check(key, hashes) {
    const cached = new Set();
    for (const part of chunk(hashes, 100)) {
      const data = await tb(key, 'POST', '/torrents/checkcached', { params: { format: 'list' }, json: { hashes: part } });
      for (const d of data || []) cached.add(String(d.hash).toLowerCase());
    }
    return cached;
  },
  async resolve(key, hash, hint) {
    const created = await tb(key, 'POST', '/torrents/createtorrent', {
      form: new URLSearchParams({ magnet: magnet(hash), allow_zip: 'false' }),
    }).catch((e) => {
      if (e.code === 'DIFF_ISSUE') throw DOWNLOADING();
      throw e;
    });
    if (!created?.torrent_id) throw DOWNLOADING();
    const t = await tb(key, 'GET', '/torrents/mylist', { params: { id: created.torrent_id, bypass_cache: 'true' } });
    if (!t?.download_present) throw DOWNLOADING();
    const f = pickFile(t.files || [], hint, (x) => x.name || x.short_name);
    if (!f) throw NO_VIDEO();
    return `${TB}/torrents/requestdl?${new URLSearchParams({ token: key, torrent_id: t.id, file_id: f.id, redirect: 'true' })}`;
  },
};

/* ---------------- Real-Debrid ---------------- */

async function rd(key, method, path, form) {
  const res = await fetch(`${RD}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}` },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (res.status === 204) return null;
  const r = await readJSON(res);
  if (!res.ok) throw new DebridError(r?.error || `HTTP_${res.status}`);
  return r;
}

const realdebrid = {
  label: 'Real-Debrid', short: 'RD', canCheck: false, // RD removed its instant-availability check
  async resolve(key, hash, hint) {
    const rdName = (f) => f.path, rdSize = (f) => f.bytes;
    const open = async (id) => {
      let info;
      for (let i = 0; i < 10; i++) {
        info = await rd(key, 'GET', `/torrents/info/${id}`);
        if (!['magnet_conversion', 'queued'].includes(info.status)) break;
        await sleep(1500);
      }
      return info;
    };

    // reuse a matching torrent already in the account
    const list = (await rd(key, 'GET', '/torrents?limit=100')) || [];
    const existing = list.find((x) => String(x.hash).toLowerCase() === hash && x.status === 'downloaded');
    let info = existing ? await open(existing.id) : null;
    if (info) {
      const target = pickFile(info.files, hint, rdName, rdSize);
      if (!target || !target.selected) info = null; // wanted file not in that copy → add fresh
    }
    if (!info) {
      const { id } = await rd(key, 'POST', '/torrents/addMagnet', { magnet: magnet(hash) });
      info = await open(id);
      if (info.status === 'waiting_files_selection') {
        const target = pickFile(info.files, hint, rdName, rdSize);
        if (!target) throw NO_VIDEO();
        await rd(key, 'POST', `/torrents/selectFiles/${id}`, { files: String(target.id) });
        info = await open(id);
      }
    }
    if (info.status !== 'downloaded') throw DOWNLOADING();
    const selected = info.files.filter((f) => f.selected);
    const target = pickFile(selected, hint, rdName, rdSize) || selected[0];
    const link = info.links[selected.indexOf(target)] || info.links[0];
    if (!link) throw NO_VIDEO();
    const un = await rd(key, 'POST', '/unrestrict/link', { link });
    return un.download;
  },
};

/* ---------------- AllDebrid ---------------- */

async function ad(key, path, params = {}, form) {
  const url = new URL(`${AD}${path}`);
  url.searchParams.set('agent', 'streamfilter');
  for (const [k, v] of Object.entries(params)) url.searchParams.append(k, v);
  const res = await fetch(url, {
    method: form ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}` },
    body: form ? new URLSearchParams(form) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const r = await readJSON(res);
  if (!r || r.status !== 'success') throw new DebridError(r?.error?.code || `HTTP_${res.status}`, r?.error?.message);
  return r.data;
}

function flattenAD(entries, prefix = '') {
  return (entries || []).flatMap((e) =>
    Array.isArray(e.e) ? flattenAD(e.e, `${prefix}${e.n}/`) : [{ ...e, n: `${prefix}${e.n}` }]);
}

const alldebrid = {
  label: 'AllDebrid', short: 'AD', canCheck: false, // AD removed its instant-availability check
  async resolve(key, hash, hint) {
    const up = await ad(key, '/v4/magnet/upload', {}, { 'magnets[]': magnet(hash) });
    const m = up.magnets && up.magnets[0];
    if (!m || m.error) throw new DebridError(m?.error?.code || 'UPLOAD_FAILED', m?.error?.message);
    if (!m.ready) {
      const st = await ad(key, '/v4.1/magnet/status', { id: m.id });
      const mag = Array.isArray(st.magnets) ? st.magnets[0] : st.magnets;
      if (mag?.statusCode !== 4) throw DOWNLOADING();
    }
    const filesData = await ad(key, '/v4/magnet/files', { 'id[]': m.id });
    const files = flattenAD(filesData.magnets?.[0]?.files);
    const f = pickFile(files, hint, (x) => x.n, (x) => x.s);
    if (!f) throw NO_VIDEO();
    const un = await ad(key, '/v4/link/unlock', { link: f.l });
    return un.link;
  },
};

/* ---------------- Premiumize ---------------- */

async function pm(path, params, { post = false } = {}) {
  let res;
  if (post) {
    res = await fetch(`${PM}${path}`, { method: 'POST', body: new URLSearchParams(params), signal: AbortSignal.timeout(TIMEOUT) });
  } else {
    const url = new URL(`${PM}${path}`);
    for (const [k, v] of params) url.searchParams.append(k, v);
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  }
  const r = await readJSON(res);
  if (!r || r.status !== 'success') throw new DebridError(r?.message || `HTTP_${res.status}`);
  return r;
}

const premiumize = {
  label: 'Premiumize', short: 'PM', canCheck: true,
  async check(key, hashes) {
    const cached = new Set();
    for (const part of chunk(hashes, 50)) {
      const r = await pm('/cache/check', [['apikey', key], ...part.map((h) => ['items[]', h])]);
      part.forEach((h, i) => { if (r.response?.[i]) cached.add(h); });
    }
    return cached;
  },
  async resolve(key, hash, hint) {
    const r = await pm('/transfer/directdl', { apikey: key, src: magnet(hash) }, { post: true }).catch(() => null);
    if (!r?.content?.length) {
      await pm('/transfer/create', { apikey: key, src: magnet(hash) }, { post: true }).catch(() => {});
      throw DOWNLOADING();
    }
    const f = pickFile(r.content, hint, (x) => x.path, (x) => x.size);
    if (!f) throw NO_VIDEO();
    return f.link;
  },
};

const SERVICES = { torbox, realdebrid, alldebrid, premiumize };

module.exports = { SERVICES, DebridError, pickFile };
