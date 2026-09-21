// Is the trip itself sound?
//
// Every other check here looks at the app: does it render, do the pins sit on land, do
// the numbers read the right way round. None of them looks at the plan. A trip can have
// perfect pins and still put you in two places at once, leave a night with no bed, or
// hold a hire car you returned yesterday.
//
// This reads the trip as a travel agent would and complains about what does not add up.
// Everything it reports is arithmetic on the trip's own data - dates against dates,
// distance against the gap in the timetable - so a complaint is never a matter of taste.
//
// Usage, from tools/:
//   npm run trip
//   npm run trip -- --snapshot t.json

import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  return Object.fromEntries(Object.entries((await res.json()).fields).map(([k, v]) => [k, plain(v)]));
}

const problems = [], notes = [];
const bad = (what, detail) => problems.push({ what, detail });
const note = (what, detail) => notes.push({ what, detail });

const metres = (a, b) => {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};
const mins = t => { const m = /^(\d{1,2}):(\d{2})/.exec(String(t || '')); return m ? +m[1] * 60 + +m[2] : null; };
// "3.10" plus the trip's year, as a real date.
const dayDate = (d, year) => { const [dd, mm] = String(d).split('.').map(Number); return new Date(Date.UTC(year, mm - 1, dd)); };
const HEB_DOW = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const tour = await loadTrip();
const year = Number(String(tour.startDate).slice(0, 4));
const days = tour.days || [];
const start = new Date(tour.startDate + 'T00:00:00Z');
const end = new Date(tour.endDate + 'T00:00:00Z');

// ---- 1. the days line up with the trip's own dates ----
const spanDays = Math.round((end - start) / 86400000) + 1;
if (days.length !== spanDays) {
  bad('מספר הימים', `הטיול מוגדר ${spanDays} ימים אבל יש ${days.length} ימים ביומן`);
}
for (const d of days) {
  const dt = dayDate(d.date, year);
  if (dt < start || dt > end) bad('יום מחוץ לטווח', `${d.date} לא בין ${tour.startDate} ל-${tour.endDate}`);
  const real = HEB_DOW[dt.getUTCDay()];
  if (d.day_of_week && d.day_of_week !== real) {
    bad('יום בשבוע שגוי', `${d.date} רשום "${d.day_of_week}" אבל הוא יום ${real}`);
  }
}

// ---- 2. the timetable runs forwards ----
for (const d of days) {
  let prev = null, prevAct = '';
  for (const it of d.items || []) {
    const m = mins(it.time);
    if (m === null) continue;
    if (prev !== null && m < prev) {
      bad('שעות לא בסדר עולה', `${d.date}: "${String(prevAct).slice(0, 40)}" ב-${fmt(prev)} ואחריו "${String(it.activity).slice(0, 40)}" ב-${it.time}`);
    }
    prev = m; prevAct = it.activity;
  }
}
function fmt(m) { return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); }

// ---- 3. you cannot be in two places at once ----
// Straight-line distance against the gap in the timetable. Roads are longer than a
// straight line, so an implied straight-line speed above 80 km/h by road is impossible,
// not merely tight. Flights are exempt - that is the whole point of a flight.
for (const d of days) {
  const pts = (d.items || []).filter(it => it.lat && it.lng && mins(it.time) !== null);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (a.type === 'flight' || b.type === 'flight') continue;
    const gap = mins(b.time) - mins(a.time);
    const km = metres({ lat: +a.lat, lng: +a.lng }, { lat: +b.lat, lng: +b.lng }) / 1000;
    if (km < 1) continue;
    if (gap <= 0) {
      if (km > 1) bad('שתי נקודות באותה שעה', `${d.date} ${b.time}: ${km.toFixed(1)} ק״מ בין "${String(a.activity).slice(0, 30)}" ל-"${String(b.activity).slice(0, 30)}"`);
      continue;
    }
    const kmh = km / (gap / 60);
    if (kmh > 80) {
      bad('אין מספיק זמן לנסיעה', `${d.date}: ${km.toFixed(1)} ק״מ ב-${gap} דק׳ בין "${String(a.activity).slice(0, 30)}" ל-"${String(b.activity).slice(0, 30)}" - ${Math.round(kmh)} קמ״ש בקו אווירי`);
    } else if (kmh > 55) {
      note('נסיעה צפופה', `${d.date}: ${km.toFixed(1)} ק״מ ב-${gap} דק׳ - ${Math.round(kmh)} קמ״ש בקו אווירי, בלי עצירות`);
    }
  }
}

// ---- 4. every night has a bed ----
const nightOf = i => { const dt = new Date(start); dt.setUTCDate(dt.getUTCDate() + i); return dt; };
const hotelNights = new Set();
for (const h of (tour.bookings?.hotels || [])) {
  const ci = dayDate(String(h.checkin).split(' ')[0], year);
  const n = Number(h.nights) || 0;
  for (let k = 0; k < n; k++) {
    const d = new Date(ci); d.setUTCDate(d.getUTCDate() + k);
    hotelNights.add(d.toISOString().slice(0, 10));
  }
}
for (let i = 0; i < spanDays - 1; i++) {           // the last night is the flight home
  const iso = nightOf(i).toISOString().slice(0, 10);
  if (!hotelNights.has(iso)) bad('לילה בלי מלון', `${iso} - אין הזמנת מלון שמכסה את הלילה הזה`);
}

// ---- 5. the car is there when the plan drives ----
const carWindows = (tour.bookings?.cars || []).map(c => {
  const [pd, pt] = String(c.pickup).split(' ');
  const [dd, dt2] = String(c.dropoff).split(' ');
  return { from: dayDate(pd, year).getTime() + (mins(pt) || 0) * 60000,
           to: dayDate(dd, year).getTime() + (mins(dt2) || 1439) * 60000,
           who: c.company };
});
for (const d of days) {
  for (const it of d.items || []) {
    const drives = /נסיעה|נוסעים|יציאה מ|לנסוע/.test(String(it.activity)) && !/מונית|טיסה|הליכה/.test(String(it.activity));
    if (!drives) continue;
    const at = dayDate(d.date, year).getTime() + (mins(it.time) ?? 0) * 60000;
    if (!carWindows.some(w => at >= w.from && at <= w.to)) {
      note('נסיעה בלי רכב בידיים', `${d.date} ${it.time}: "${String(it.activity).slice(0, 45)}" - אין השכרה פעילה בשעה הזו`);
    }
  }
}

// ---- 6. deadlines that have already gone ----
const today = new Date();
for (const p of (tour.prep || [])) {
  if (p.done || !p.deadline) continue;
  const dl = new Date(p.deadline + 'T23:59:59Z');
  const left = Math.ceil((dl - today) / 86400000);
  if (left < 0) bad('יעד שעבר', `"${String(p.task).slice(0, 55)}" - היה אמור להיסגר לפני ${-left} ימים`);
  else if (left <= 3) note('יעד קרוב', `"${String(p.task).slice(0, 55)}" - נשארו ${left} ימים`);
}

// ---- 7. the flights bracket the trip ----
for (const f of (tour.bookings?.flights || [])) {
  const dt = dayDate(f.date, year);
  if (dt < start || dt > end) bad('טיסה מחוץ לטווח', `${f.date} ${f.flight} לא בין ${tour.startDate} ל-${tour.endDate}`);
}

// ---- 8. nothing is quietly empty ----
for (const d of days) {
  if (!d.items || !d.items.length) bad('יום ריק', `${d.date} בלי אף פעילות`);
  if (!d.title) bad('יום בלי כותרת', d.date);
}
for (const [cat, list] of Object.entries(tour.bookings || {})) {
  for (const b of list || []) {
    if (!b.name && !b.company && !b.flight) bad('הזמנה בלי שם', `${cat}: ${JSON.stringify(b).slice(0, 60)}`);
  }
}

// ---- report ----
console.log(`נבדק: ${tour.title} · ${days.length} ימים · ${tour.startDate} עד ${tour.endDate}\n`);
if (problems.length) {
  console.log('בעיות:');
  for (const p of problems) console.log(`  ✗ ${p.what} — ${p.detail}`);
  console.log('');
}
if (notes.length) {
  console.log('שווה מבט:');
  for (const n of notes) console.log(`  · ${n.what} — ${n.detail}`);
  console.log('');
}
if (!problems.length && !notes.length) console.log('הכל מסתדר: תאריכים, שעות, מרחקים, לינה, רכב ויעדים.');
else if (!problems.length) console.log('אין בעיות. הפריטים שלמעלה הם הערות בלבד.');
process.exit(problems.length ? 1 : 0);
