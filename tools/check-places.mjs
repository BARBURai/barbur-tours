// Do the places we point at actually exist where we point?
//
// The owner looked at the restaurant pins next to Google Maps and said they were not
// even in the right direction. He was right to doubt them: the coordinates came from a
// list he forwarded, and that list already had one measurable error in it - a distance
// given as 150m that is really 322m.
//
// cyprus.pmtiles carries a "pois" layer: OpenStreetMap's own named points, the same
// data the app draws. So a name can be looked up in the map itself. For each named
// place in the trip this finds the nearest POI carrying that name and reports how far
// our coordinate is from it. No network, no guessing, no Google.
//
// Usage, from tools/:
//   npm run places
//   npm run places -- --snapshot t.json

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive, layer, tileXY, fromTile, metres, findArchive, NO_ARCHIVE } from './pmtiles-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const SNAPSHOT = opt('snapshot', null);
const TRIP = opt('trip', 'cyprus-2026');
const Z = 15;

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
  return Object.fromEntries(Object.entries((await res.json()).fields).map(([k, v]) => [k, plain(v)]));
}

// A pin that deliberately differs from OSM is a decision, and it is written down with
// its reason rather than left to fail every run. A gate that can never pass is a gate
// people stop reading.
const EXC_FILE = join(ROOT, 'tools', 'place-exceptions.json');
const EXCEPTIONS = existsSync(EXC_FILE) ? JSON.parse(readFileSync(EXC_FILE, 'utf8')).places : [];
const declaredFor = name => EXCEPTIONS.find(e => String(name).toLowerCase().includes(e.name.toLowerCase()));

const ARCHIVE = findArchive(ROOT, TRIP);
if (!ARCHIVE) {
  console.log(NO_ARCHIVE);
  process.exit(0);                   // land-check is the one that fails on this
}
const arc = new Archive(ARCHIVE);

// Named points from every tile within `rings` tiles of a centre, as lat/lng.
function poisAround(lat, lng, rings) {
  const c = tileXY(lat, lng, Z);
  const cx = Math.floor(c.x), cy = Math.floor(c.y);
  const out = [];
  for (let dx = -rings; dx <= rings; dx++) {
    for (let dy = -rings; dy <= rings; dy++) {
      const raw = arc.tile(Z, cx + dx, cy + dy);
      if (!raw) continue;
      for (const kind of ['pois', 'places']) {
        for (const f of layer(raw, kind)) {
          const name = f.props.name || f.props['name:en'] || f.props['name:el'];
          if (!name || !f.rings.length || !f.rings[0].length) continue;
          const [px, py] = f.rings[0][0];
          const p = fromTile(cx + dx + px / f.extent, cy + dy + py / f.extent, Z);
          out.push({ name, kind: f.props.kind || '', lat: p.lat, lng: p.lng });
        }
      }
    }
  }
  return out;
}

// Matching names is where this goes wrong if you are careless. A first attempt tied
// "To Souvlaki Tou Soukri" to a different shop called "Souvlaki.GR" on the shared word
// souvlaki, and tied "Leonardo Boutique Hotel Larnaca" to a POI called "B'". A check
// that invents matches is worse than no check, so the bar here is a distinctive word:
// a token of four letters or more that is not a category word every third taverna has.
const GENERIC = new Set([
  'the', 'and', 'tou', 'tis', 'ton', 'restaurant', 'tavern', 'taverna', 'cafe', 'bar',
  'grill', 'fish', 'seafood', 'souvlaki', 'gyros', 'pizza', 'pizzeria', 'kebab', 'hotel',
  'resort', 'suites', 'apartments', 'boutique', 'beach', 'centre', 'center', 'house',
  'garden', 'sea', 'old', 'new', 'club', 'lounge', 'bistro', 'kitchen', 'food', 'rentals',
  'rent', 'car', 'cars', 'divers', 'diving', 'scuba', 'wellness', 'spa', 'limited', 'ltd'
]);
function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\u0370-\u03ff]+/g, ' ').trim();
}
function distinctive(s) {
  return norm(s).split(' ').filter(w => w.length >= 4 && !GENERIC.has(w));
}
function looksLike(poiName, wanted) {
  const da = distinctive(poiName), db = distinctive(wanted);
  if (!da.length || !db.length) return false;
  // one distinctive word in common, or one name's distinctive word inside the other
  return da.some(a => db.some(b => a === b || (a.length >= 5 && b.includes(a)) || (b.length >= 5 && a.includes(b))));
}

// A name in common is not enough. "Alpha Divers" matched a bookmaker called "Bet on
// Alpha" 600m away, and "Ristorante Bacco" matched three tobacconists. A dive centre is
// not a betting shop, so the kind of place has to fit the kind of thing we are looking
// for, or the match does not count.
const KINDS = {
  eat:      new Set(['restaurant', 'cafe', 'fast_food', 'bar', 'pub', 'biergarten', 'ice_cream', 'food_court']),
  hotels:   new Set(['hotel', 'guest_house', 'hostel', 'motel', 'apartment', 'resort', 'chalet']),
  cars:     new Set(['car_rental', 'car', 'rental']),
  activities: new Set(['dive_centre', 'scuba_diving', 'sports_centre', 'boat_rental', 'water_sports', 'marina', 'attraction'])
};

const tour = await loadTrip();

// Everything the app points at that carries a name worth looking up.
const targets = [];
(tour.days || []).forEach(d => {
  ((d.eat && d.eat.places) || []).forEach(p => {
    if (p.lat && p.lng) targets.push({ what: `איפה לאכול ${d.date}`, name: p.name, lat: +p.lat, lng: +p.lng, want: 'eat' });
  });
});
Object.entries(tour.bookings || {}).forEach(([cat, list]) => {
  (list || []).forEach(b => {
    if (b.lat && b.lng && (b.name || b.company)) {
      targets.push({ what: `הזמנות/${cat}`, name: b.name || b.company, lat: +b.lat, lng: +b.lng, want: cat });
    }
  });
});

const seen = new Set();
const rows = [];
for (const t of targets) {
  const key = t.name + '|' + t.lat + ',' + t.lng;
  if (seen.has(key)) continue;
  seen.add(key);
  // Two passes: close by first, then a wide sweep before concluding it is not there.
  const kindOk = p => {
    const set = KINDS[t.want];
    return !set || !p.kind || set.has(p.kind);
  };
  const ok = p => looksLike(p.name, t.name) && kindOk(p);
  let hits = poisAround(t.lat, t.lng, 2).filter(ok);
  if (!hits.length) hits = poisAround(t.lat, t.lng, 8).filter(ok);
  if (!hits.length) { rows.push({ ...t, verdict: 'not in the map' }); continue; }
  hits.forEach(h => { h.d = metres(t, h); });
  hits.sort((a, b) => a.d - b.d);
  rows.push({ ...t, verdict: 'found', hit: hits[0] });
}
arc.close();

const NEAR = 120;                    // a pin this close is the same place by any reading
const good = rows.filter(r => r.verdict === 'found' && r.hit.d <= NEAR);
const allOff = rows.filter(r => r.verdict === 'found' && r.hit.d > NEAR).sort((a, b) => b.hit.d - a.hit.d);
const declared = allOff.filter(r => declaredFor(r.name));
const off = allOff.filter(r => !declaredFor(r.name));
const miss = rows.filter(r => r.verdict !== 'found');

console.log(`looked up ${rows.length} named places in the basemap's own OpenStreetMap data\n`);
console.log(`within ${NEAR}m of where the map puts them: ${good.length}`);
for (const r of good) console.log(`  ${Math.round(r.hit.d).toString().padStart(4)}m  ${r.name}  -> "${r.hit.name}"`);

if (off.length) {
  console.log('\nPOINTING AT THE WRONG PLACE:');
  for (const r of off) {
    console.log(`  ${r.name}  (${r.what})`);
    console.log(`     we send you to   ${r.lat}, ${r.lng}`);
    console.log(`     the map has it at ${r.hit.lat.toFixed(5)}, ${r.hit.lng.toFixed(5)}  ("${r.hit.name}"${r.hit.kind ? ', ' + r.hit.kind : ''})`);
    console.log(`     that is ${(r.hit.d / 1000).toFixed(2)} km away`);
  }
}
if (declared.length) {
  console.log('\ndeliberately different from the map, with a reason on file:');
  for (const r of declared) {
    console.log(`  ${r.name} - ${(r.hit.d / 1000).toFixed(2)} km from the OSM point`);
    console.log(`     ${declaredFor(r.name).why}`);
  }
}
if (miss.length) {
  console.log('\nnot present in the basemap by name (cannot confirm or deny from here):');
  for (const r of miss) console.log(`  ${r.name}  (${r.what})`);
}
process.exit(off.length ? 1 : 0);
