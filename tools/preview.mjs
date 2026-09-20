// Open the app in a real browser and photograph it.
//
// This exists because of a bug that shipped to the owner's phone: the estimate lines
// rendered the literal string "undefined". Both of the accounts that work on this repo
// had "checked" the change - one read the diff, the other ran a syntax check - and
// neither had looked at the screen, because neither could. The owner found it.
//
// There is no test suite here and there should not be one; this is a single-page app
// whose whole job is to look right on a phone with no signal. The check that matters is
// looking at it. This makes that possible without a phone in hand.
//
// Usage, from tools/:
//   npm install          (once)
//   npm run preview                        - home screen, live trip data
//   npm run preview -- --views home,map    - several screens
//   npm run preview -- --trip georgia-2026
//   npm run preview -- --theme light
//   npm run preview -- --snapshot trip.json  - no network: read the trip from a file
//
// Screenshots land in .preview/ (git-ignored). A non-zero exit means something is
// actually broken: a page error, or a screen rendering "undefined"/"NaN".

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.preview');

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const TRIP = opt('trip', 'cyprus-2026');
const VIEWS = opt('views', 'home').split(',').map(v => v.trim()).filter(Boolean);
const THEME = opt('theme', 'dark');
const SNAPSHOT_FILE = opt('snapshot', null);
// A phone, because that is the only place this app is ever used.
const WIDTH = Number(opt('width', 390));
const HEIGHT = Number(opt('height', 844));

// ---------- the trip data ----------
// Firestore is unreachable from some sandboxes, and the app's own offline path reads a
// snapshot out of localStorage. Priming that key is both simpler than stubbing Firebase
// and a truer test: it exercises the fallback the travellers actually depend on.

function plain(value) {
  const kind = Object.keys(value)[0];
  const v = value[kind];
  if (kind === 'integerValue') return Number(v);
  if (kind === 'doubleValue') return Number(v);
  if (kind === 'nullValue') return null;
  if (kind === 'arrayValue') return (v.values || []).map(plain);
  if (kind === 'mapValue') return Object.fromEntries(Object.entries(v.fields || {}).map(([k, x]) => [k, plain(x)]));
  return v; // stringValue, booleanValue, timestampValue
}

async function loadTrip() {
  if (SNAPSHOT_FILE) {
    const raw = JSON.parse(await readFile(resolve(SNAPSHOT_FILE), 'utf8'));
    return raw.tours ? raw.tours : [raw];
  }
  const html = await readFile(join(ROOT, 'index.html'), 'utf8');
  const key = html.match(/apiKey:\s*"([^"]+)"/)?.[1];
  if (!key) throw new Error('could not find the Firebase apiKey in index.html');
  const url = `https://firestore.googleapis.com/v1/projects/barbur-tours/databases/(default)/documents/tours/${TRIP}?key=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Firestore returned ${res.status} for ${TRIP}.\n` +
      `If this network cannot reach googleapis.com, save the trip to a file and pass --snapshot <file>.`
    );
  }
  const doc = await res.json();
  return [{ id: TRIP, ...Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, plain(v)])) }];
}

// ---------- a static server for the working tree ----------
// Deliberately the files on disk, not the deployed site: the point is to see a change
// before it reaches anyone.

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.woff2': 'font/woff2', '.pmtiles': 'application/octet-stream'
};

function serve() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    const file = join(ROOT, path === '/' ? 'index.html' : path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let body;
    try { body = await readFile(file); }
    catch { res.writeHead(404).end('not found'); return; }

    const type = TYPES[extname(file)] || 'application/octet-stream';
    // The basemap is a .pmtiles archive read with HTTP Range requests - the library
    // never fetches the whole 49MB file. A server that answers 200 with the lot makes
    // the map screen fail here for a reason that does not exist in production, which
    // would make this tool useless for exactly the screen it is most needed on.
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
      if (start > end || start >= body.length) {
        res.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
        return;
      }
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Range': `bytes ${start}-${end}/${body.length}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': end - start + 1
      }).end(body.subarray(start, end + 1));
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes' }).end(body);
  });
  return new Promise(ok => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

// ---------- chromium ----------

async function chromiumPath(chromium) {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (base && existsSync(base)) {
    const dirs = (await readdir(base)).filter(d => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      const exe = join(base, d, 'chrome-linux', 'chrome');
      if (existsSync(exe)) return exe;
    }
  }
  try { return chromium.executablePath(); } catch { return undefined; }
}

// ---------- run ----------

const tours = await loadTrip();
console.log(`trip: ${tours[0].title || TRIP}  (dataVersion ${tours[0].dataVersion ?? '-'})`);

const { chromium } = await import('playwright-core');
const { server, port } = await serve();
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: await chromiumPath(chromium) });
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });

const problems = [];
const offline = new Set();
const origin = () => `http://127.0.0.1:${port}`;

page.on('pageerror', e => problems.push(`page error: ${e.message.split('\n')[0]}`));
page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) problems.push(`console: ${m.text().slice(0, 180)}`); });

// A file this repo serves that comes back 404, or fails outright, is a real bug - a
// missing font or vendored library breaks the app offline, which is the whole point of
// it. A request to gstatic or open-meteo that cannot leave the sandbox is not; it is
// the same no-signal condition the app is built to survive, so it is reported as
// context rather than failure.
const external = url => !url.startsWith(origin());
page.on('requestfailed', r => {
  if (external(r.url())) { offline.add(new URL(r.url()).hostname); return; }
  // ERR_ABORTED means something cancelled the request, not that the server failed to
  // answer it - closing the browser while the 49MB basemap is still streaming produces
  // one every run. A tool that reports that as a fault teaches you to ignore it, and
  // then you ignore the real one too. A 404 still gets flagged, by the response handler.
  if (r.failure()?.errorText === 'net::ERR_ABORTED') return;
  problems.push(`local request failed: ${r.url().replace(origin(), '')} (${r.failure()?.errorText})`);
});
page.on('response', r => {
  if (r.status() >= 400 && !external(r.url())) problems.push(`local ${r.status()}: ${r.url().replace(origin(), '')}`);
});

await page.addInitScript(([snapshot, trip, theme]) => {
  try {
    localStorage.setItem('toursSnapshot', snapshot);
    localStorage.setItem('lastTripId', trip);
    localStorage.setItem('theme', theme);
  } catch {}
}, [JSON.stringify({ at: Date.now(), tours }), TRIP, THEME]);

await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'domcontentloaded' });
// init() runs on db-ready; with no Firebase the app falls back after its own 6s timer.
await page.waitForFunction(() => !document.body.innerText.includes('טוען...'), null, { timeout: 25000 })
  .catch(() => problems.push('the app never finished loading'));
await page.waitForTimeout(1200);

for (const view of VIEWS) {
  await page.evaluate(v => { if (typeof navigate === 'function') navigate(v); }, view);
  await page.waitForTimeout(1200);
  // Collapsed <details> hide real content from both the screenshot and the text check.
  await page.evaluate(() => document.querySelectorAll('details').forEach(d => { d.open = true; }));
  await page.waitForTimeout(400);

  const text = await page.evaluate(() => document.body.innerText);
  for (const bad of ['undefined', 'NaN', '[object Object]']) {
    if (text.includes(bad)) problems.push(`"${bad}" is rendered on the ${view} screen`);
  }

  const file = join(OUT, `${view}-${THEME}.png`);
  await page.screenshot({ path: file, fullPage: true });
  await writeFile(join(OUT, `${view}-${THEME}.txt`), text);
  console.log(`  ${view.padEnd(10)} -> .preview/${view}-${THEME}.png`);
}

await browser.close();
server.close();

if (offline.size) {
  console.log(`\nunreachable from here (the app's offline path was exercised instead): ${[...offline].join(', ')}`);
}

if (problems.length) {
  console.error('\nPROBLEMS:');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}
console.log('\nno page errors, no missing local files, nothing rendered as undefined.');
console.log('Now look at the screenshots. That is the part no check can do for you.');
