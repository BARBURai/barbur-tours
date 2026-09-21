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
    cmd: ['node', ['check-places.mjs', ...extra]] },
  { name: 'trip',    why: 'the plan holds up: dates, times, travel time, a bed every night',
    cmd: ['node', ['trip-check.mjs', ...extra]] }
];

const results = [];
for (const s of STEPS) {
  process.stdout.write(`\n──── ${s.name}: ${s.why}\n`);
  const r = spawnSync(s.cmd[0], pass(s.cmd[1]), { cwd: HERE, stdio: 'inherit' });
  results.push({ ...s, code: r.status });
}

const HE = {
  preview: 'כל המסכים נטענים, בלי שגיאות',
  bidi:    'המספרים בעברית לא מתהפכים',
  land:    'אף נקודה לא שולחת אותך לים',
  places:  'כל מקום יושב איפה שהמפה אומרת',
  trip:    'התוכנית מחזיקה: תאריכים, שעות, מרחקים, לינה'
};

console.log('\n════════════════════════════════════════');
let failed = 0;
for (const r of results) {
  const ok = r.code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '\u2713' : '\u2717'}  ${(HE[r.name] || r.why)}`);
}
console.log('════════════════════════════════════════');
if (failed) {
  console.log(`\n\u2717  ${failed} מתוך ${results.length} נכשלו. לא מוכן לשליחה.`);
  console.log('   הפרטים למעלה. לתקן, או לומר לבעלים בפירוש מה נכשל ולמה.');
  process.exit(1);
}
console.log('\n\u2713  הכל עובר. הצילומים ב-.preview/ — עכשיו להסתכל עליהם,');
console.log('   כי שום בדיקה לא אומרת אם המסך קריא.');
