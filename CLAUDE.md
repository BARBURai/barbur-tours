# Barbur Tours

A personal, offline-first travel companion. One trip at a time, in Hebrew, on a phone,
in a country where the data roaming may or may not work. Every design decision in here
follows from that last clause.

**Owner:** BARBURai. Two Claude accounts work on this repo, in turns — see
[Working agreement](#working-agreement).

## What it is

A single-page PWA served as static files from this repository. Trips live in Firestore
(project `barbur-tours`, collection `tours`); everything else is local. There is no
build step, no bundler, no package manager, no test suite. You edit `index.html` and
that is the deploy.

```
index.html        the entire app - 3.5k lines
sw.js             service worker (cache shell, offline routing)
manifest.json     PWA manifest
cyprus.pmtiles    49MB Protomaps basemap for the Cyprus trip
vendor/           maplibre-gl, pmtiles, protomaps themes, Rubik font subsets
icon-192/512.png  app icons
```

Nothing is loaded from a CDN except the two version-pinned Firebase ES modules. Map
libraries and fonts are vendored **on purpose**: an offline-first app cannot depend on a
CDN being reachable, and the service worker can only cache what it can fetch same-origin.
Do not "modernise" a vendored file back into a CDN link.

## Layout of index.html

Three blocks, in this order:

| Lines (approx) | What |
| --- | --- |
| 15-110 | `<script type="module">` - Firebase init and the `window.DB` API. The only module script. |
| 112-642 | `<style>` - all CSS, including `@font-face` and the theme tokens. |
| 646-823 | Markup - header, drawer, the ten `<section class="view">` blocks, trip modal, bottom nav. |
| 825-3566 | `<script>` - all application code, classic (non-module) so every handler is a global. |

Line numbers move on every commit. The stable landmarks are the `// ---------- Name ----------`
section comments in the main script; navigate by those:

`Drawer` · `Navigation` · `Offline map` · `Theme` · `Offline state` · `Trip status helper`
· `Render drawer trip list` · `Select trip` · `Empty state` · `Trip form` · `Helpers`
· one-time seeds · `Itinerary rendering` · `Bookings rendering` · `Currency rendering`
· `Packing rendering` · `Prep checklist` · `Phrases` · `Emergency` · `Transport`
· `Notifications` · `Init`

### Views

Ten sections, one visible at a time, switched by `navigate(view)`:
`home` `itinerary` `bookings` `currency` `packing` `prep` `phrases` `emergency`
`transport` `map`.

Five of them are in the bottom nav (home, itinerary, bookings, map, packing); the rest
are reached from the drawer. The drawer is the real navigation — the bottom nav is the
shortcut, not the map of the app.

### State

One global `STATE = { currentView, currentTripId, tours, editingTripId, selectedFlag }`.
`curTour()` resolves the current trip. There is no framework, no reactivity and no
component tree: a screen changes because a `render*(tour)` function rewrites its
container's `innerHTML`. Keep it that way unless the owner asks otherwise — half a
framework would be worse than none.

## Data

Firestore `tours/{id}`, read and written only through `window.DB`
(`listTours` `getTour` `saveTour` `deleteTour` `watchTour`). `saveTour` merges, so a
screen can persist just its own slice (`saveDays`, the packing and prep writers).

Offline reads are defended twice over: Firestore's own IndexedDB persistence is the
first line, and a `toursSnapshot` copy in `localStorage` is the second, for the case
where IndexedDB was evicted or never populated on that device. `DB.fromCache` and
`DB.lastSync` drive the staleness bar. A trip is never allowed to simply be unavailable
abroad.

Trips were seeded once each by `window.seedCyprus` / `seedGeorgia` / `seedKorea`. These
are historical one-shots kept for reference, not a data layer.

External data: Open-Meteo for the forecast (cached, stale beats empty), an FX rate for
the currency screen.

## Offline and the service worker

`CACHE` in `sw.js` is the deploy version — currently `barbur-tours-v25`. **Bump it in
any commit that changes a file listed in `SHELL`**, or returning users keep the old
copy; `activate` deletes every cache that is not the current `CACHE`.

Three deliberate exceptions in the `fetch` handler, each with the reason in a comment
above it — read them before touching that file:

- `googleapis.com` passes straight through (intercepting it breaks Firestore's own cache
  and its long-lived listen channel).
- `.pmtiles` passes straight through (Range requests produce 206s the Cache API refuses
  to store; the map screen saves the whole archive to IndexedDB itself).
- Navigations are network-first with the cached shell as fallback; everything same-origin
  is cache-first.

Install uses `Promise.allSettled`, not `cache.addAll`, so one failed request cannot leave
a user with no offline copy at all.

## The map

One `.pmtiles` archive read directly by the pmtiles library — no tile server. The user
downloads it once to IndexedDB from the map screen, and it works with no signal after
that. GPS, distance/bearing helpers, per-day pins and an optional trail overlay
(off by default). All of it lives under the `Offline map` section.

## Conventions

- **Hebrew, RTL.** `<html lang="he" dir="rtl">`. All UI strings are Hebrew. Phone numbers
  need `linkPhones` to stay readable in RTL — do not hand-roll that again.
- **Theme.** Dark is the default; light exists. Never hard-code a colour — use the tokens
  on `:root` (`--bg --surface --surface-2 --accent --accent-2 --text --text-dim
  --text-faint --border --red --green --blue --radius --radius-sm --shadow`) and their
  `:root[data-theme="light"]` overrides.
- **Phone-first.** Portrait, `viewport-fit=cover`, standalone. Check anything you change
  at phone width before calling it done.
- **Comments explain why, not what.** The existing comments record decisions and the bugs
  that caused them. Match that register; keep them when you touch the code around them.
- **English in the repo** (comments, commit messages), Hebrew in the UI.
- **Commit messages** say what changed for the user, in plain words, lowercase after the
  first letter — e.g. "Make the drawer the navigation, and stop the home screen sprawling".

## Working agreement

Two Claude accounts work on this repo. **`main` is the single source of truth and we work
in turns** — nobody starts while the other's turn is open. Almost all the code is in one
file, so parallel work means conflicts inside a 2,700-line script, which is exactly where
things break quietly.

Each turn:

1. Sync first: `git fetch origin main && git checkout -B <your-branch> origin/main`.
   Never build on a stale `main`.
2. One task = one commit = one PR = squash-merge into `main`. No long-lived branches.
3. Bump `CACHE` in `sw.js` if the change touches a `SHELL` file.
4. Update the handoff log below in the same commit.
5. Hand the turn back explicitly.

There is no test suite; verification is opening the app and looking at it. Say plainly
what you checked and what you did not.

## Handoff log

Newest first. One entry per turn: what changed, which sections, anything left open.

- **2026-09-19 — session B (claude/barbur-torus-code-v66jy2)** — Added this file. No app
  code touched. Drafted from the code and git history alone, so the sections marked
  "unconfirmed" below still need the owner.

## Unconfirmed — owner to fill in

Everything above is derived from the code and the commit history. These are not:

- **How this is deployed and served.** GitHub Pages? A custom domain? Push-to-deploy, or
  a manual step?
- **Who uses it.** Just the owner, or the travellers on the trip too?
- **Firestore rules and access.** The web API key is in the client, as it must be — what
  actually guards the `tours` collection?
- **What the next trip is**, and whether Cyprus is live or finished.
- **Anything decided in chat and never written down** — rejected approaches, things that
  must not change, promises made to whoever uses the app.
