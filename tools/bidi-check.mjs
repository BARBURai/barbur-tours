// Catch the bug that only a screenshot has ever caught.
//
// Three times now a run of numbers in Hebrew prose has rendered in the wrong order:
// "(35.03961, 32.39958)" came out as "(32.39958, 35.03961)", "(18, 21, 55)" came out
// reversed, and "7 St. George's Tavern" came out as "St. George's Tavern 7". The bidi
// algorithm reorders neutrals and digit runs against the RTL paragraph, and innerText
// cannot see any of it - it returns logical order, the order the string was written in.
// So every automated check the repo had was blind to it, and the rule in CLAUDE.md was
// "only a photograph will tell you".
//
// A photograph is not the only way. A Range around each number gives its position in
// pixels, and in an RTL line the number written first must sit furthest right. This
// walks every screen, compares what is written against where it lands, and fails when
// they disagree.
//
// Runs inside an element the page has deliberately made left-to-right - a phone number,
// a Latin restaurant name, the summary value on a fold - are skipped: there the written
// order is meant to run the other way, and comparing them would report every correct
// phone number as a fault.
//
// Usage, from tools/:
//   npm run bidi                       - live trip data
//   npm run bidi -- --snapshot t.json  - a trip from a file, no network

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const TRIP = opt('trip', 'cyprus-2026');
const SNAPSHOT_FILE = opt('snapshot', null);
const VIEWS = opt('views', 'home,itinerary,bookings,currency,packing,prep,phrases,emergency,transport,map')
  .split(',').map(v => v.trim()).filter(Boolean);

function plain(value) {
  const kind = Object.keys(value)[0], v = value[kind];
  if (kind === 'integerValue' || kind === 'doubleValue') return Number(v);
  if (kind === 'nullValue') return null;
  if (kind === 'arrayValue') return (v.values || []).map(plain);
  if (kind === 'mapValue') return Object.fromEntries(Object.entries(v.fields || {}).map(([k, x]) => [k, plain(x)]));
  return v;
}

async function loadTrip() {
  if (SNAPSHOT_FILE) {
    const raw = JSON.parse(await readFile(resolve(SNAPSHOT_FILE), 'utf8'));
    return raw.tours ? raw.tours : [raw];
  }
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const key = html.match(/apiKey:\s*"([^"]+)"/)?.[1];
  const res = await fetch(`https://firestore.googleapis.com/v1/projects/barbur-tours/databases/(default)/documents/tours/${TRIP}?key=${key}`);
  if (!res.ok) throw new Error(`Firestore returned ${res.status}; pass --snapshot <file> instead.`);
  const doc = await res.json();
  return [{ id: TRIP, ...Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, plain(v)])) }];
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.woff2': 'font/woff2', '.pmtiles': 'application/octet-stream' };

function serve() {
  const server = createServer(async (req, res) => {
    const file = join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let body; try { body = await readFile(file); } catch { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' }).end(body);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

// Runs in the page.
//
// What is being tested is narrow on purpose. Under RTL the words always come out in the
// order they were written, so "is it in order" is not a question worth asking. The
// question that matters is the one that shipped twice: a list of numbers that a reader
// reads left to right, laid out right to left because the line around it is Hebrew.
//
// "(35.03961, 32.39958)" was displayed as "(32.39958, 35.03961)" and "(18, 21, 55)" came
// out reversed. The cause is in the bidi algorithm: a comma followed by a space between
// two numbers is not a number separator, so the pair splits into two runs and the line
// places them right to left. A Hebrew reader is served correctly. Anyone reading the
// pair as a coordinate, or as three ages, reads it backwards.
//
// So this looks for exactly that shape - two or more numbers joined by nothing but a
// comma or a semicolon - and then measures whether it really did lay out against its
// reading order before saying a word. Shape plus measurement, so a true report is
// always a real one.
//
// What it does NOT catch, and no tool can: a digit that belongs to a Latin name, like
// the 7 in "7 St. George's Tavern", which renders at the far end of the name. The same
// shape in "לילה 1: Leonardo" is correct there, and nothing but meaning separates them.
// For that class the answer is still to look at the picture.
function scan() {
  const findings = [];
  const HEB = /[֐-׿]/;
  // A number as a reader sees it, then the same again, joined by only a comma.
  const NUMLIST = /\d[\d.:\/]*(?:\s*[,;]\s*\d[\d.:\/]*)+/g;
  const ltrContext = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      if (getComputedStyle(n).direction === 'ltr') return true;
    }
    return false;
  };
  const rectOf = (node, i) => {
    const r = document.createRange();
    r.setStart(node, i); r.setEnd(node, i + 1);
    const b = r.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top) };
  };
  const walk = node => {
    if (node.nodeType === 3) {
      const txt = node.textContent;
      if (!HEB.test(txt)) return;                        // not an RTL line in practice
      if (node.parentElement && ltrContext(node.parentElement)) return;
      for (const m of txt.matchAll(NUMLIST)) {
        const first = rectOf(node, m.index);
        const last = rectOf(node, m.index + m[0].length - 1);
        if (first.top !== last.top) continue;            // wrapped; left says nothing
        if (first.left > last.left) findings.push({ run: m[0], text: txt.trim().slice(0, 120) });
      }
      return;
    }
    if (node.nodeType === 1 && node.offsetParent === null && node.tagName !== 'BODY') return;
    node.childNodes.forEach(walk);
  };
  walk(document.body);
  return findings;
}

const tours = await loadTrip();
const { chromium } = await import('playwright-core');
const { server, port } = await serve();

let exe;
const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
if (base && existsSync(base)) {
  for (const d of (await readdir(base)).filter(d => d.startsWith('chromium-')).sort().reverse()) {
    const e = join(base, d, 'chrome-linux', 'chrome');
    if (existsSync(e)) { exe = e; break; }
  }
}
const browser = await chromium.launch({ executablePath: exe });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await page.addInitScript(([snapshot, trip]) => {
  try { localStorage.setItem('toursSnapshot', snapshot); localStorage.setItem('lastTripId', trip); } catch {}
}, [JSON.stringify({ at: Date.now(), tours }), TRIP]);
await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !document.body.innerText.includes('טוען...'), null, { timeout: 25000 });
await page.waitForTimeout(1000);

const problems = [];
const seen = new Set();
let screens = 0;
for (const view of VIEWS) {
  // The itinerary is ten screens wearing one name; a day at a time is the only way in.
  const days = view === 'itinerary'
    ? ((tours[0].days || []).map((_, i) => i))
    : [null];
  for (const day of days) {
    await page.evaluate(([v, d]) => {
      if (typeof navigate === 'function') navigate(v);
      if (d !== null && typeof setDay === 'function') setDay(d);
    }, [view, day]);
    await page.waitForTimeout(450);
    // Collapsed content is invisible to getBoundingClientRect as much as to the eye.
    await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
    await page.waitForTimeout(250);
    screens++;
    for (const f of await page.evaluate(scan)) {
      const key = f.run + '|' + f.text;
      if (!seen.has(key)) { seen.add(key); problems.push({ where: view + (day === null ? '' : ' day ' + (day + 1)), ...f }); }
    }
  }
}

await browser.close();
server.close();

console.log(`checked ${screens} screens for number lists laid out against their reading order`);
if (problems.length) {
  console.error('\nREAD BACKWARDS ON SCREEN:');
  for (const p of problems) {
    console.error(`  ${p.where}: "${p.run}"`);
    console.error(`    in: "${p.text}"`);
  }
  console.error('\nAnchor each number to a Hebrew word ("איתן בן 18, אורי בן 21"), or separate them');
  console.error('with \u00b7 instead of a comma. A coordinate belongs in lat/lng, never in prose.');
  process.exit(1);
}
console.log('no number list in Hebrew prose is laid out backwards.');
