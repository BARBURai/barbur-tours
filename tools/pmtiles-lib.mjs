// A small read-only PMTiles v3 + Mapbox Vector Tile reader, shared by the checks in
// this folder. It exists because cyprus.pmtiles is already in the repo: it is
// OpenStreetMap data, it works with no network, and it is the very basemap the app
// draws, so an answer from here is an answer about what the traveller will see.

import { openSync, readSync, closeSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

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
    e[i].offset = v === 0 && i > 0 ? e[i - 1].offset + e[i - 1].length : v - 1;
  }
  return e;
}

// Tiles are ordered along a Hilbert curve, after every tile of every shallower zoom.
export function tileId(z, x, y) {
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
  if (e.runLength === 0) return e;
  return id < e.tileId + e.runLength ? e : null;
}

export class Archive {
  constructor(path) {
    this.fd = openSync(path, 'r');
    const h = this.read(0, 127);
    if (h.toString('utf8', 0, 7) !== 'PMTiles' || h[7] !== 3) throw new Error('not a PMTiles v3 archive');
    const u = o => Number(h.readBigUInt64LE(o));
    this.rootOff = u(8); this.rootLen = u(16);
    this.leafOff = u(40);
    this.dataOff = u(56);
    this.minZoom = h[100]; this.maxZoom = h[101];
    this.root = readDirectory(gunzipSync(this.read(this.rootOff, this.rootLen)));
    this.cache = new Map();
  }
  read(off, len) { const b = Buffer.alloc(len); readSync(this.fd, b, 0, len, off); return b; }
  tile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const id = tileId(z, x, y);
    let e = find(this.root, id);
    for (let guard = 0; e && e.runLength === 0 && guard < 4; guard++) {
      const leaf = readDirectory(gunzipSync(this.read(this.leafOff + e.offset, e.length)));
      e = find(leaf, id);
    }
    const out = (!e || e.runLength === 0) ? null : gunzipSync(this.read(this.dataOff + e.offset, e.length));
    this.cache.set(key, out);
    return out;
  }
  close() { closeSync(this.fd); }
}

// ---------- protobuf / MVT ----------

export function* fields(buf, end = buf.length, p = 0) {
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

function packed(buf, start, end) {
  const out = [];
  let p = start;
  while (p < end) {
    let v = 0, shift = 0, byte;
    do { byte = buf[p++]; v += (byte & 0x7f) * Math.pow(2, shift); shift += 7; } while (byte >= 0x80);
    out.push(v);
  }
  return out;
}

function value(buf, f) {
  for (const vf of fields(buf, f.end, f.start)) {
    if (vf.tag === 1) return buf.toString('utf8', vf.start, vf.end);   // string
    if (vf.tag === 2) return buf.readFloatLE(vf.start);
    if (vf.tag === 3) return buf.readDoubleLE(vf.start);
    if (vf.tag === 4 || vf.tag === 5) return vf.value;
    if (vf.tag === 6) return (vf.value >> 1) ^ (-(vf.value & 1));
    if (vf.tag === 7) return !!vf.value;
  }
  return null;
}

// Every feature of one layer, with its tags decoded and its geometry in tile units.
export function layer(tile, wanted) {
  for (const f of fields(tile)) {
    if (f.tag !== 3) continue;
    let name = null, extent = 4096;
    const keys = [], values = [], feats = [];
    for (const lf of fields(tile, f.end, f.start)) {
      if (lf.tag === 1) name = tile.toString('utf8', lf.start, lf.end);
      else if (lf.tag === 5) extent = lf.value;
      else if (lf.tag === 2) feats.push(lf);
      else if (lf.tag === 3) keys.push(tile.toString('utf8', lf.start, lf.end));
      else if (lf.tag === 4) values.push(value(tile, lf));
    }
    if (name !== wanted) continue;
    const out = [];
    for (const feat of feats) {
      let type = 0, geom = null, tags = [];
      for (const ff of fields(tile, feat.end, feat.start)) {
        if (ff.tag === 3) type = ff.value;
        else if (ff.tag === 4) geom = ff;
        else if (ff.tag === 2) tags = ff.type === 2 ? packed(tile, ff.start, ff.end) : [ff.value];
      }
      const props = {};
      for (let i = 0; i + 1 < tags.length; i += 2) props[keys[tags[i]]] = values[tags[i + 1]];
      const rings = [];
      if (geom) {
        const cmds = packed(tile, geom.start, geom.end);
        let i = 0, cx = 0, cy = 0, ring = null;
        while (i < cmds.length) {
          const cmd = cmds[i] & 0x7, count = cmds[i] >> 3;
          i++;
          if (cmd === 1) {
            for (let k = 0; k < count; k++) {
              cx += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
              cy += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
              if (ring && ring.length) rings.push(ring);
              ring = [[cx, cy]];
            }
          } else if (cmd === 2) {
            for (let k = 0; k < count; k++) {
              cx += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
              cy += (cmds[i] >> 1) ^ (-(cmds[i] & 1)); i++;
              ring.push([cx, cy]);
            }
          } else if (cmd === 7) {
            if (ring && ring.length) { rings.push(ring); ring = null; }
          }
        }
        if (ring && ring.length) rings.push(ring);
      }
      out.push({ type, props, rings, extent });
    }
    return out;
  }
  return [];
}

// ---------- geography ----------

export function tileXY(lat, lng, z) {
  const n = Math.pow(2, z);
  const r = lat * Math.PI / 180;
  return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n };
}

export function fromTile(x, y, z) {
  const n = Math.pow(2, z);
  return { lng: x / n * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n))) * 180 / Math.PI };
}

export function metres(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
