// The gate. Nothing ships without this passing.
//
// Every check in this folder existed before the trip data went wrong; none of them was
// mandatory, so none of them ran. This makes them one command with one verdict, so
// there is no version of "I checked" that skips a step.
//
// Usage, from tools/:
//   npm run check                       - against the live trip
//   npm run check -- --snapshot t.json  - against a file, no network

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const pass = args => args;
const extra = process.argv.slice(2);

const STEPS = [
  { name: 'preview', why: 'every screen renders, no JS error, nothing shows undefined',
    cmd: ['node', ['preview.mjs', '--views', 'home,itinerary,bookings,currency,packing,prep,phrases,emergency,transport,map', ...extra]] },
  { name: 'bidi',    why: 'no number list in Hebrew prose is laid out backwards',
    cmd: ['node', ['bidi-check.mjs', ...extra]] },
  { name: 'land',    why: 'no point sends anyone into the sea',
    cmd: ['node', ['land-check.mjs', ...extra]] },
  { name: 'places',  why: 'every named place sits where the map says it sits',
    cmd: ['node', ['check-places.mjs', ...extra]] }
];

const results = [];
for (const s of STEPS) {
  process.stdout.write(`\n──── ${s.name}: ${s.why}\n`);
  const r = spawnSync(s.cmd[0], pass(s.cmd[1]), { cwd: HERE, stdio: 'inherit' });
  results.push({ ...s, code: r.status });
}

console.log('\n════════════════════════════════════════');
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(8)} ${r.why}`);
}
if (failed) {
  console.log('\nNOT READY. Fix the failures above, or state each one explicitly to the owner');
  console.log('as a known exception with the reason. Never ship past a FAIL in silence.');
  process.exit(1);
}
console.log('\nAll gates pass. Screenshots are in .preview/ - now look at them, because');
console.log('none of this tells you whether the screen reads well.');
