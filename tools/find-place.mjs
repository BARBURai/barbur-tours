// Where is this place, really?
//
// This exists so that no coordinate ever again enters the app from memory, from prose,
// or from a list somebody forwarded. Nineteen of them did, and they were wrong by up to
// four and a half kilometres - one of them put the Blue Lagoon anchorage on the wrong
// side of the peninsula, and several put restaurants and a castle out in the sea.
//
// The basemap in this repo is OpenStreetMap data and it carries the names. So the
// workflow for adding a place is: look it up here, paste what comes back. Not: write a
// number that looks about right and check it later.
//
// Usage, from tools/:
//   npm run find -- "Zephyros"
//   npm run find -- "Hondros" --near paphos
//   npm run find -- "tavern" --near latchi --kind restaurant --all

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Archive, layer, tileXY, fromTile, metres, findArchive, NO_ARCHIVE } from './pmtiles-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
// The first bare word that is not the value of a --flag.
const FLAGS_WITH_VALUE = new Set(['--near', '--kind', '--archive']);
let query = null;
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) { if (FLAGS_WITH_VALUE.has(args[i])) i++; continue; }
  query = args[i];
  break;
}

if (!query) {
  console.error('usage: npm run find -- "<name>" [--near <place|lat,lng>] [--kind <kind>] [--archive <file>] [--all]');
  process.exit(2);
}

// Somewhere to start looking. A trip's own towns are the useful defaults; anything else
// can be given as a coordinate.
const ANCHORS = {
  larnaca: [34.9100, 33.6380], לרנקה: [34.9100, 33.6380],
  paphos:  [34.7600, 32.4200], פאפוס: [34.7600, 32.4200],
  latchi:  [35.0400, 32.3990], לאצי: [35.0400, 32.3990],
  akamas:  [35.0300, 32.3300], אקמאס: [35.0300, 32.3300],
  chlorakas: [34.7900, 32.4050],
  cyprus:  [35.0000, 33.0000]
};

const nearArg = opt('near', 'cyprus');
let centre;
if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(nearArg)) {
  const [a, b] = nearArg.split(',').map(Number);
  centre = [a, b];
} else if (ANCHORS[nearArg.toLowerCase()]) {
  centre = ANCHORS[nearArg.toLowerCase()];
} else {
  console.error(`unknown --near "${nearArg}". Give a coordinate, or one of: ${Object.keys(ANCHORS).join(', ')}`);
  process.exit(2);
}

const Z = 15;
// A wide sweep by default: being slow beats missing the place and inventing one instead.
const RINGS = nearArg === 'cyprus' ? 40 : 10;
const kindWanted = opt('kind', null);
const archive = opt('archive', findArchive(ROOT, null));
if (!archive) {
  console.error(NO_ARCHIVE);
  process.exit(2);
}

const arc = new Archive(archive);
const c = tileXY(centre[0], centre[1], Z);
const cx = Math.floor(c.x), cy = Math.floor(c.y);
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9Ͱ-Ͽ֐-׿]+/g, ' ').trim();
const want = norm(query);

const hits = new Map();
for (let dx = -RINGS; dx <= RINGS; dx++) {
  for (let dy = -RINGS; dy <= RINGS; dy++) {
    const raw = arc.tile(Z, cx + dx, cy + dy);
    if (!raw) continue;
    for (const lay of ['pois', 'places', 'landuse']) {
      for (const f of layer(raw, lay)) {
        const name = f.props.name || f.props['name:en'] || f.props['name:el'];
        if (!name || !f.rings.length || !f.rings[0].length) continue;
        const n = norm(name);
        // A name with no Latin, Greek or Hebrew letters normalises to nothing - and an
        // empty string is "contained in" every query, so without this guard a search for
        // "Psariko" returns Cyrillic corner shops. A tool that answers with places that
        // are not the place is the exact failure it was built to stop.
        if (!n) continue;
        if (!n.includes(want) && !want.includes(n)) continue;
        if (kindWanted && f.props.kind !== kindWanted) continue;
        const [px, py] = f.rings[0][0];
        const p = fromTile(cx + dx + px / f.extent, cy + dy + py / f.extent, Z);
        const key = name + '|' + p.lat.toFixed(5) + ',' + p.lng.toFixed(5);
        if (!hits.has(key)) hits.set(key, { name, kind: f.props.kind || lay, ...p });
      }
    }
  }
}
arc.close();

const list = [...hits.values()];
list.forEach(h => { h.d = metres({ lat: centre[0], lng: centre[1] }, h); });
list.sort((a, b) => a.d - b.d);

if (!list.length) {
  console.log(`"${query}" is not in ${archive.split('/').pop()} near ${nearArg}.`);
  console.log('');
  console.log('That means no coordinate for it can be confirmed from here. Either ask the');
  console.log('owner to long-press it in Google Maps, or leave it with a search string and');
  console.log('say plainly that it is unverified. Do not write a coordinate that "looks right".');
  process.exit(1);
}

console.log(`${list.length} match${list.length > 1 ? 'es' : ''} for "${query}" near ${nearArg}:\n`);
for (const h of (args.includes('--all') ? list : list.slice(0, 8))) {
  console.log(`  ${h.lat.toFixed(5)}, ${h.lng.toFixed(5)}   ${h.name}`);
  console.log(`      ${h.kind} · ${h.d < 1000 ? Math.round(h.d) + 'm' : (h.d / 1000).toFixed(1) + 'km'} from ${nearArg}`);
}
console.log('\nPaste as:  lat:<first>,lng:<second>');
