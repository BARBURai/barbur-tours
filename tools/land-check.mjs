// Is every point we send someone to actually on land?
//
// The owner noticed some map points leading into the sea. That is checkable without
// guessing and without a network: cyprus.pmtiles already sits in this repo, and a
// Protomaps basemap carries an "earth" layer - the land polygon itself. A point on
// land falls inside it. A point in the water does not.
//
// So this reads the archive directly (PMTiles v3: header, hilbert-ordered directory,
// gzipped Mapbox Vector Tiles), decodes the earth polygons for the tile containing
// each point, and runs point-in-polygon. No rendering: an earlier session tried to
// verify coordinates by screenshotting the map here and got blank canvases, which
// proves nothing either way. Vector geometry does not have that problem.
//
// Usage, from tools/:
//   npm run land                        - live trip data
//   npm run land -- --snapshot t.json

import { openSync, readSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findArchive, NO_ARCHIVE } from './pmtiles-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- PMTiles v3 ----------

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  varint() {
    let r = 0, s = 0, byte;
    do { byte = this.b[this.p++]; r += (byte & 0x7f) * Math.pow(2, s); s += 7; } while (byte >= 0x80);
    return r;
  }
}

function readDirectory(buf) {
  const r = new Reader(buf);
  const n = r.varint();
  const e = Array.from({ length: n }, () => ({ tileId: 0, offset: 0, length: 0, runLength: 0 }));
  let last = 0;
  for (let i = 0; i < n; i++) { last += r.varint(); e[i].tileId = last; }
  for (let i = 0; i < n; i++) e[i].runLength = r.varint();
  for (let i = 0; i < n; i++) e[i].length = r.varint();
  for (let i = 0; i < n; i++) {
    const v = r.varint();
    // 0 means "directly after the previous entry" - the common case in a clustered archive.
    e[i].offset = v === 0 && i > 0 ? e[i - 1].offset + e[i - 1].length : v - 1;
  }
  return e;
}

// PMTiles orders tiles along a Hilbert curve, so a tile id is the curve position
// plus every tile of every shallower zoom.
function tileId(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += Math.pow(4, t);
  let rx, ry, d = 0, tx = x, ty = y;
  for (let s = Math.pow(2, z) / 2; s >= 1; s /= 2) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      const t = tx; tx = ty; ty = t;
    }
  }
  return acc + d;
}

function find(entries, id) {
  let lo = 0, hi = entries.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].tileId <= id) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (best < 0) return null;
  const e = entries[best];
  if (e.runLength === 0) return e;                       // a leaf directory to descend into
  return id < e.tileId + e.runLength ? e : null;
}

class Archive {
  constructor(path) {
    this.fd = openSync(path, 'r');
    const h = this.read(0, 127);
    if (h.toString('utf8', 0, 7) !== 'PMTiles' || h[7] !== 3) throw new Error('not a PMTiles v3 archive');
    const u = o => Number(h.readBigUInt64LE(o));
    this.rootOff = u(8); this.rootLen = u(16);
    this.leafOff = u(40); this.leafLen = u(48);
    this.dataOff = u(56);
    this.maxZoom = h[101];
    this.root = readDirectory(gunzipSync(this.read(this.rootOff, this.rootLen)));
  }
  read(off, len) { const b = Buffer.alloc(len); readSync(this.fd, b, 0, len, off); return b; }
  tile(z, x, y) {
    const id = tileId(z, x, y);
    let e = find(this.root, id);
    // One level of leaf directories is all a 49MB extract needs, but follow as many as exist.
    for (let guard = 0; e && e.runLength === 0 && guard < 4; guard++) {
      const leaf = readDirectory(gunzipSync(this.read(this.leafOff + e.offset, e.length)));
      e = find(leaf, id);
    }
    if (!e || e.runLength === 0) return null;
    return gunzipSync(this.read(this.dataOff + e.offset, e.length));
  }
  close() { closeSync(this.fd); }
}

// ---------- Mapbox Vector Tile ----------
// Only what is needed to get polygon rings out of one named layer.

function* fields(buf, end = buf.length, p = 0) {
  while (p < end) {
    let key = 0, shift = 0, byte;
    do { byte = buf[p++]; key += (byte & 0x7f) * Math.pow(2, shift); shift += 7; } while (byte >= 0x80);
    const tag = key >> 3, type = key & 7;
    if (type === 2) {
      let len = 0; shift = 0;
      do { byte = buf[p++]; len += (byte & 0x7f) * Math.pow(2, shift); shift += 7; } while (byte >= 0x80);
      yield { tag, type, start: p, end: p + len };
      p += len;
    } else if (type === 0) {
      const s = p;
      do { byte = buf[p++]; } while (byte >= 0x80);
      let v = 0; shift = 0;
      for (let i = s; i < p; i++) { v += (buf[i] & 0x7f) * Math.pow(2, shift); shift += 7; }
      yield { tag, type, value: v };
    } else if (type === 5) { yield { tag, type, value: buf.readUInt32LE(p) }; p += 4; }
    else if (type === 1) { yield { tag, type, value: Number(buf.readBigUInt64LE(p)) }; p += 8; }
    else throw new Error('wire type ' + type);
  }
}

function varints(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    let v = 0, shift = 0, byte;
    do { byte = buf[p++]; v += (byte & 0x7f) * Math.pow(2, shift); shift += 7; } while (byte >= 0x80);
    out.push(v);
  }
  return out;
}

// Rings of every polygon feature in one layer, in tile-local units.
function polygonRings(tile, layerName) {
  const rings = [];
  for (const f of fields(tile)) {
    if (f.tag !== 3) continue;                            // Tile.layers
    let name = null, extent = 4096;
    const features = [];
    for (const lf of fields(tile, f.end, f.start)) {
      if (lf.tag === 1) name = tile.toString('utf8', lf.start, lf.end);
      else if (lf.tag === 5) extent = lf.value;
      else if (lf.tag === 2) features.push(lf);
    }
    if (name !== layerName) continue;
    for (const feat of features) {
      let type = 0, geom = null;
      for (const ff of fields(tile, feat.end, feat.start)) {
        if (ff.tag === 3) type = ff.value;
        else if (ff.tag === 4) geom = ff;
      }
      if (type !== 3 || !geom) continue;                  // polygons only
      const cmds = varints(tile, geom.start, geom.end);
      let i = 0, cx = 0, cy = 0, ring = null;
      while (i < cmds.length) {
        const cmd = cmds[i] & 0x7, count = cmds[i] >> 3;
        i++;
        if (cmd === 1) {                                  // MoveTo - starts a ring
          for (let k = 0; k < count; k++) {
            cx += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
            cy += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
            if (ring && ring.length) rings.push({ ring, extent });
            ring = [[cx, cy]];
          }
        } else if (cmd === 2) {                           // LineTo
          for (let k = 0; k < count; k++) {
            cx += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
            cy += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
            ring.push([cx, cy]);
          }
        } else if (cmd === 7) {                           // ClosePath
          if (ring && ring.length) { rings.push({ ring, extent }); ring = null; }
        }
      }
      if (ring && ring.length) rings.push({ ring, extent });
    }
  }
  return rings;
}

// ---------- geography ----------

function tileXY(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = (lng + 180) / 360 * n;
  const r = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
  return { x, y };
}

// Even-odd: a hole is just another ring, so islands-in-lakes come out right.
function inside(px, py, rings) {
  let hit = false;
  for (const { ring } of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}


// Distance in metres from a tile-local point to the nearest edge of any ring. A binary
// land/sea answer is useless within the generalisation of a coastline at one zoom -
// "in the water" means nothing if it is four metres out. The number is what decides.
function metresToLand(px, py, rings, lat, z) {
  // one tile-unit in metres, at this latitude
  const extent = rings.length ? rings[0].extent : 4096;
  const worldTiles = Math.pow(2, z);
  const metresPerTile = 40075016.686 * Math.cos(lat * Math.PI / 180) / worldTiles;
  const unit = metresPerTile / extent;
  let best = Infinity, bestX = 0, bestY = 0;
  for (const { ring } of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      let t = len2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = x1 + t * dx, ey = y1 + t * dy;
      const d = Math.hypot(px - ex, py - ey);
      if (d < best) { best = d; bestX = ex; bestY = ey; }
    }
  }
  return { metres: best * unit, x: bestX, y: bestY };
}

// ---------- the trip ----------

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SNAPSHOT = opt('snapshot', null);
const TRIP = opt('trip', 'cyprus-2026');

function plain(v) {
  const k = Object.keys(v)[0], x = v[k];
  if (k === 'integerValue' || k === 'doubleValue') return Number(x);
  if (k === 'nullValue') return null;
  if (k === 'arrayValue') return (x.values || []).map(plain);
  if (k === 'mapValue') return Object.fromEntries(Object.entries(x.fields || {}).map(([a, b]) => [a, plain(b)]));
  return x;
}

async function loadTrip() {
  if (SNAPSHOT) { const raw = JSON.parse(readFileSync(resolve(SNAPSHOT), 'utf8')); return raw.tours ? raw.tours[0] : raw; }
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const key = html.match(/apiKey:\s*"([^"]+)"/)[1];
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/barbur-tours/databases/(default)/documents/tours/${TRIP}?key=${key}`);
  if (!res.ok) throw new Error(`Firestore returned ${res.status}; pass --snapshot <file>.`);
  const doc = await res.json();
  return Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, plain(v)]));
}

// Every point the app will actually send somebody to.
function points(tour) {
  const out = [];
  (tour.days || []).forEach(d => {
    (d.items || []).forEach(it => {
      if (it.lat && it.lng) out.push({ where: `יומן ${d.date} ${it.time || ''}`, name: it.activity, lat: +it.lat, lng: +it.lng });
    });
    ((d.eat && d.eat.places) || []).forEach(p => {
      if (p.lat && p.lng) out.push({ where: `איפה לאכול ${d.date}`, name: p.name, lat: +p.lat, lng: +p.lng });
    });
  });
  Object.entries(tour.bookings || {}).forEach(([cat, list]) => {
    (list || []).forEach(b => {
      if (b.lat && b.lng) out.push({ where: `הזמנות/${cat}`, name: b.name || b.company || '', lat: +b.lat, lng: +b.lng });
    });
  });
  return out;
}

const tour = await loadTrip();
const all = points(tour);
// Dedupe by coordinate: the airport and the marina repeat across days, and a point is
// on land or it is not regardless of how many lines mention it.
const byCoord = new Map();
for (const p of all) {
  const k = p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
  if (!byCoord.has(k)) byCoord.set(k, { ...p, uses: [] });
  byCoord.get(k).uses.push(p.where);
}

// Prove the reader works before trusting a word it says: one point deep inland and one
// well out to sea, both obvious, both far from any coastline generalisation.
const CONTROLS = [
  { name: 'ניקוסיה - עמוק ביבשה', lat: 35.1700, lng: 33.3600, expect: 'land' },
  { name: 'עשרה ק״מ מדרום ללרנקה - ים פתוח', lat: 34.8000, lng: 33.6500, expect: 'sea' },
  { name: 'מרכז מדבר טרודוס - הר אולימפוס', lat: 34.9350, lng: 32.8630, expect: 'land' },
  { name: 'אמצע המפרץ בין פאפוס לאקמאס', lat: 34.9500, lng: 32.2000, expect: 'sea' }
];

// Some points belong in the water - a boat anchorage is the obvious one. They are
// declared, with a reason, so this run can go green on a correct trip. A check that can
// never pass is a check people stop reading, and then it misses the real thing.
const EXC_FILE = join(ROOT, 'tools', 'water-exceptions.json');
const EXCEPTIONS = existsSync(EXC_FILE) ? JSON.parse(readFileSync(EXC_FILE, 'utf8')).points : [];
const isDeclared = p => EXCEPTIONS.find(e =>
  Math.abs(e.lat - p.lat) < 0.0005 && Math.abs(e.lng - p.lng) < 0.0005);

// No basemap means nothing here can be verified. That is not the trip's fault and it
// must not read as one - but it must not read as a pass either. A trip carrying
// coordinates with no map to check them against is exactly the state that put pins in
// the sea, so that combination fails loudly; a trip with no coordinates yet is fine.
const ARCHIVE = findArchive(ROOT, tour.id || TRIP);
if (!ARCHIVE) {
  console.log(NO_ARCHIVE + '\n');
  const withCoords = all.length;
  if (withCoords) {
    console.error(`\u2717  ${withCoords} נקודות כבר בטיול ואין מול מה לאמת אותן.`);
    console.error('   זה בדיוק המצב שבו נקודות הגיעו מניחוש. או שמביאים את קובץ המפה,');
    console.error('   או שמורידים את הנקודות ומשאירים search בלבד.');
    process.exit(1);
  }
  console.log('אין עדיין נקודות בטיול, אז אין מה לאמת. תקין.');
  process.exit(0);
}

const arc = new Archive(ARCHIVE);
const Z = 15;                                             // the archive's deepest zoom: the sharpest coastline it has
const cache = new Map();
const sea = [], land = [];

// The land verdict comes from the point's own tile, but the distance to land needs the
// eight tiles around it too: a tile that is all water has no edge to measure against,
// and a point near a tile border is metres from a coastline drawn in the next tile.
// Rings from neighbours are shifted into the centre tile's coordinate space first.
function ringsAround(tx, ty) {
  const out = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${tx + dx}/${ty + dy}`;
      if (!cache.has(key)) {
        const raw = arc.tile(Z, tx + dx, ty + dy);
        cache.set(key, raw ? polygonRings(raw, 'earth') : []);
      }
      for (const r of cache.get(key)) {
        const ext = r.extent;
        out.push({ extent: ext, ring: r.ring.map(([x, y]) => [x + dx * ext, y + dy * ext]) });
      }
    }
  }
  return out;
}

function classify(p) {
  const t = tileXY(p.lat, p.lng, Z);
  const tx = Math.floor(t.x), ty = Math.floor(t.y);
  const own = cache.has(`${tx}/${ty}`) ? cache.get(`${tx}/${ty}`) : null;
  const near = ringsAround(tx, ty);
  const home = cache.get(`${tx}/${ty}`) || [];
  const extent = (near.length ? near[0].extent : 4096);
  const px = (t.x - tx) * extent, py = (t.y - ty) * extent;
  p.verdict = inside(px, py, home) ? 'land' : 'sea';
  if (near.length) {
    const n = metresToLand(px, py, near, p.lat, Z);
    p.metres = n.metres;
    // Turn the nearest edge back into a coordinate, so a report can say where the
    // land actually is rather than only how far away it is.
    const world = { x: tx + n.x / extent, y: ty + n.y / extent };
    const scale = Math.pow(2, Z);
    p.nearLng = world.x / scale * 360 - 180;
    p.nearLat = Math.atan(Math.sinh(Math.PI * (1 - 2 * world.y / scale))) * 180 / Math.PI;
  } else { p.metres = Infinity; }
  return p;
}

const controls = CONTROLS.map(classify);
for (const p of byCoord.values()) {
  classify(p);
  (p.verdict === 'land' ? land : sea).push(p);
}
arc.close();

console.log(`checked ${byCoord.size} distinct points against the earth layer of cyprus.pmtiles (z${Z})\n`);

if (args.includes('--all')) {
  console.log('every point, nearest land first:');
  for (const p of [...land, ...sea].sort((a, b) => a.metres - b.metres)) {
    console.log(`  ${p.verdict.padEnd(4)} ${Math.round(p.metres).toString().padStart(4)}m  ${p.lat}, ${p.lng}  ${p.name.slice(0, 50)}`);
  }
  console.log('');
}

console.log('controls:');
let controlsOk = true;
for (const c of controls) {
  const ok = c.verdict === c.expect;
  if (!ok) controlsOk = false;
  console.log(`  ${ok ? 'OK   ' : 'WRONG'} ${c.name}: ${c.verdict}, ${Math.round(c.metres)}m from the coastline (expected ${c.expect})`);
}
if (!controlsOk) {
  console.error('\nA control came out wrong, so nothing below can be trusted. Fix the reader first.');
  process.exit(2);
}

// A point a few metres offshore is the coastline's own generalisation, not a mistake
// anyone can act on: a promenade, a quay and a seafront tavern are all drawn as water
// at this zoom. Only a point far enough out that navigation would visibly send someone
// into the sea is reported as a fault.
const REAL = 60;
const declared = [];
const unexpected = sea.filter(p => {
  const e = isDeclared(p);
  if (e) { p.declared = e; declared.push(p); return false; }
  return true;
});
const offshore = unexpected.filter(p => p.metres >= REAL).sort((a, b) => b.metres - a.metres);
const edge = unexpected.filter(p => p.metres < REAL).sort((a, b) => b.metres - a.metres);

console.log(`\non land: ${land.length} · on the waterline: ${edge.length} · out in the water: ${offshore.length}` +
  (declared.length ? ` · declared exceptions: ${declared.length}` : ''));

for (const p of declared) {
  console.log(`\ndeclared exception: ${p.declared.what} - ${Math.round(p.metres)}m into the water`);
  console.log(`  ${p.declared.why}`);
}

if (edge.length) {
  console.log(`\nwithin ${REAL}m of the shore - fine, that is the coastline's own rounding:`);
  for (const p of edge) console.log(`  ${Math.round(p.metres).toString().padStart(3)}m  ${p.name.slice(0, 56)}`);
}

if (offshore.length) {
  console.log('\nOUT IN THE WATER:');
  for (const p of offshore) {
    const brg = p.nearLat === undefined ? '' :
      (() => {
        const dy = p.nearLat - p.lat, dx = (p.nearLng - p.lng) * Math.cos(p.lat * Math.PI / 180);
        const deg = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
        return ['צפונה','צפון-מזרחה','מזרחה','דרום-מזרחה','דרומה','דרום-מערבה','מערבה','צפון-מערבה'][Math.round(deg / 45) % 8];
      })();
    console.log(`  ${Math.round(p.metres)}m into the water · ${p.lat}, ${p.lng}`);
    console.log(`     ${p.name}`);
    console.log(`     nearest land is ${Math.round(p.metres)}m ${brg}, at ${p.nearLat.toFixed(5)}, ${p.nearLng.toFixed(5)}`);
    console.log(`     ${[...new Set(p.uses)].join(' · ')}`);
  }
}
process.exit(offshore.length ? 1 : 0);
