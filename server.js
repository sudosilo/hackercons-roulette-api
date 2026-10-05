// Source device: Blue Phone. Backend catalog service for the clip player.
// Pulls hacker conference talks from several open sources, normalizes them,
// stores them in Redis, and serves random playable clips to the frontend.

'use strict';

const http = require('http');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL;
const PEERTUBE_INSTANCES = (process.env.PEERTUBE_INSTANCES || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const INGEST_EVERY_MS = 6 * 60 * 60 * 1000;
const MIN_SIZE = 15000000;

const K_ITEMS = 'hcr:items';      // hash id -> record json
const K_IDS = 'hcr:ids';          // set of all ids
const K_DEAD = 'hcr:dead';        // set of ids that failed to play
const K_CONFS = 'hcr:confs';      // set of conference names
const K_MP4 = 'hcr:mp4:';         // prefix, cached playable url per id

const redis = createClient({ url: REDIS_URL });
redis.on('error', e => console.log('redis error', e.message));

// record shape used everywhere:
// { id, source, title, conference, year, duration, page, mp4 }
// mp4 may be empty until resolved on demand

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'clip-catalog/1.0' } });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}

async function saveRecord(rec) {
  await redis.hSet(K_ITEMS, rec.id, JSON.stringify(rec));
  await redis.sAdd(K_IDS, rec.id);
  if (rec.conference) await redis.sAdd(K_CONFS, rec.conference);
}

function pickRandom(arr, n) {
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// SOURCE 1: archive.org hackercons collection
async function ingestArchive() {
  let total = 0;
  for (let page = 1; page <= 5; page++) {
    const url = 'https://archive.org/advancedsearch.php?q=collection%3Ahackercons+AND+mediatype%3Amovies'
      + '&fl[]=identifier&fl[]=title&fl[]=year&fl[]=date&rows=500&page=' + page + '&output=json';
    const j = await getJson(url);
    const docs = (j.response && j.response.docs) || [];
    if (!docs.length) break;
    for (const d of docs) {
      const parts = String(d.identifier).replace(/^hackercons-/, '').split('-');
      const conf = parts[0] ? parts[0].toUpperCase() : 'UNKNOWN';
      const yearGuess = parts.find(p => /^(19|20)\d\d$/.test(p));
      await saveRecord({
        id: 'ia:' + d.identifier,
        source: 'archive.org',
        title: d.title || d.identifier,
        conference: conf,
        year: d.year || yearGuess || (d.date ? String(d.date).slice(0, 4) : ''),
        duration: 0,
        page: 'archive.org/details/' + d.identifier,
        mp4: ''
      });
      total++;
    }
  }
  console.log('archive.org records', total);
}

async function resolveArchive(identifier) {
  const j = await getJson('https://archive.org/metadata/' + identifier);
  let best = null;
  for (const f of (j.files || [])) {
    if (!/\.mp4$/i.test(f.name || '')) continue;
    if (Number(f.size || 0) <= MIN_SIZE) continue;
    if (!best || Number(f.size) > Number(best.size)) best = f;
  }
  if (!best) return null;
  return 'https://archive.org/download/' + identifier + '/' + encodeURIComponent(best.name);
}

// SOURCE 2: media.ccc.de (Chaos Computer Club and related events)
async function ingestCCC() {
  const j = await getJson('https://api.media.ccc.de/public/conferences');
  const confs = pickRandom(j.conferences || [], 40);
  let total = 0;
  for (const c of confs) {
    try {
      const detail = await getJson(c.url);
      const confName = (c.acronym || c.title || 'CCC').toUpperCase();
      for (const e of (detail.events || [])) {
        await saveRecord({
          id: 'ccc:' + e.guid,
          source: 'media.ccc.de',
          title: e.title,
          conference: confName,
          year: (e.date || e.release_date || '').slice(0, 4),
          duration: e.duration || 0,
          page: String(e.frontend_link || '').replace(/^https?:\/\//, ''),
          mp4: '',
          api: e.url
        });
        total++;
      }
    } catch (err) {
      console.log('ccc conference skipped', err.message);
    }
  }
  console.log('media.ccc.de records', total);
}

async function resolveCCC(rec) {
  const j = await getJson(rec.api);
  const vids = (j.recordings || []).filter(r => r.mime_type === 'video/mp4');
  if (!vids.length) return null;
  const hq = vids.find(r => r.high_quality) || vids[0];
  return hq.recording_url;
}

// SOURCE 3: PeerTube servers listed in the PEERTUBE_INSTANCES variable
async function ingestPeerTube() {
  for (const host of PEERTUBE_INSTANCES) {
    let total = 0;
    try {
      for (let start = 0; start < 500; start += 100) {
        const j = await getJson('https://' + host + '/api/v1/videos?count=100&start=' + start);
        const data = j.data || [];
        if (!data.length) break;
        for (const v of data) {
          await saveRecord({
            id: 'pt:' + host + ':' + v.uuid,
            source: host,
            title: v.name,
            conference: (v.channel && (v.channel.displayName || v.channel.name)) || host,
            year: (v.originallyPublishedAt || v.publishedAt || '').slice(0, 4),
            duration: v.duration || 0,
            page: host + '/w/' + v.uuid,
            mp4: '',
            api: 'https://' + host + '/api/v1/videos/' + v.uuid
          });
          total++;
        }
      }
    } catch (err) {
      console.log('peertube skipped', host, err.message);
    }
    console.log(host, 'records', total);
  }
}

async function resolvePeerTube(rec) {
  const j = await getJson(rec.api);
  let files = j.files || [];
  if (!files.length && j.streamingPlaylists && j.streamingPlaylists[0]) {
    files = j.streamingPlaylists[0].files || [];
  }
  const mp4s = files.filter(f => /\.mp4$/i.test(f.fileUrl || ''));
  if (!mp4s.length) return null;
  mp4s.sort((a, b) => (a.size || 0) - (b.size || 0));
  return mp4s[Math.floor(mp4s.length / 2)].fileUrl;
}

async function ingestAll() {
  console.log('ingest start');
  for (const fn of [ingestArchive, ingestCCC, ingestPeerTube]) {
    try { await fn(); } catch (err) { console.log('source failed', fn.name, err.message); }
  }
  console.log('ingest done, total', await redis.sCard(K_IDS));
}

async function resolve(rec) {
  const cached = await redis.get(K_MP4 + rec.id);
  if (cached) return cached;
  let url = null;
  if (rec.id.startsWith('ia:')) url = await resolveArchive(rec.id.slice(3));
  else if (rec.id.startsWith('ccc:')) url = await resolveCCC(rec);
  else if (rec.id.startsWith('pt:')) url = await resolvePeerTube(rec);
  if (url) await redis.set(K_MP4 + rec.id, url, { EX: 7 * 24 * 3600 });
  return url;
}

async function randomPlayable(source) {
  for (let tries = 0; tries < 10; tries++) {
    const ids = await redis.sRandMember(K_IDS, 20);
    if (!ids || !ids.length) return null;
    for (const id of ids) {
      if (await redis.sIsMember(K_DEAD, id)) continue;
      const raw = await redis.hGet(K_ITEMS, id);
      if (!raw) continue;
      const rec = JSON.parse(raw);
      if (source && source !== 'any' && rec.source !== source) continue;
      try {
        const url = await resolve(rec);
        if (url) { rec.mp4 = url; delete rec.api; return rec; }
        await redis.sAdd(K_DEAD, id);
      } catch (err) {
        console.log('resolve failed', id, err.message);
      }
    }
  }
  return null;
}

function send(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    if (req.method === 'OPTIONS') return send(res, 204, {});

    if (u.pathname === '/api/health') {
      return send(res, 200, { ok: true, items: await redis.sCard(K_IDS), dead: await redis.sCard(K_DEAD) });
    }

    if (u.pathname === '/api/sources') {
      const sources = ['archive.org', 'media.ccc.de'].concat(PEERTUBE_INSTANCES);
      return send(res, 200, { sources });
    }

    if (u.pathname === '/api/random') {
      const rec = await randomPlayable(u.searchParams.get('source') || 'any');
      if (!rec) return send(res, 503, { error: 'catalog is empty or still loading' });
      return send(res, 200, rec);
    }

    if (u.pathname === '/api/quiz') {
      const rec = await randomPlayable('any');
      if (!rec) return send(res, 503, { error: 'catalog is empty or still loading' });
      const others = (await redis.sRandMember(K_CONFS, 12) || []).filter(c => c !== rec.conference);
      const choices = pickRandom([rec.conference].concat(pickRandom(others, 3)), 4);
      return send(res, 200, { clip: rec, choices });
    }

    if (u.pathname === '/api/dead' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.id) {
        await redis.sAdd(K_DEAD, String(body.id));
        await redis.del(K_MP4 + String(body.id));
      }
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
});

(async () => {
  await redis.connect();
  server.listen(PORT, () => console.log('listening on', PORT));
  const count = await redis.sCard(K_IDS);
  if (count < 50) ingestAll();
  setInterval(ingestAll, INGEST_EVERY_MS);
})();
