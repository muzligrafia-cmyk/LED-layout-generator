/**********************************************************************
 * LED Layout Generator - Node engine  (led_engine.cjs)
 * ---------------------------------------------------------------
 * Step 2 of 3. Started by LED_Run.bat (which LED_Export.jsx launches
 * automatically). Reads LED_layout_input.json from the Desktop, does all
 * the heavy geometry outside Illustrator, and writes
 * LED_layout_output.json to the Desktop for LED_Import.jsx.
 *
 * All internal maths is in millimetres, in Illustrator's coordinate
 * system (Y points UP). Input/output coordinates are in points.
 *
 * How it works:
 *   - TRUE inset region: the shape is shrunk by (edge clearance + LED
 *     radius) with clipper-lib -> exact "is this centre legal?" test.
 *   - EVEN FILL: centroidal relaxation (Lloyd). LEDs shuffle apart until
 *     each owns an equal patch of surface, so the spread is even and the
 *     outer LEDs line up with the outline without crowding it.
 *   - Wobble is added on top of the even base (user setting).
 *   - CABLE RULES: a segment may never pass through another LED circle;
 *     optional: no cable crossings. Centre distance 0 = unlimited cable.
 *   - Several variants (seeds) per run.
 **********************************************************************/
'use strict';

const fs = require('fs');
const path = require('path');

// The JSON files live on the Desktop (the Illustrator Scripts folder is
// usually write-protected). LED_Run.bat passes the Desktop path as the
// first argument; if that is missing we try the usual Desktop locations
// (including OneDrive's) and take the one holding the newest input file.
const IN_NAME = 'LED_layout_input.json';
const OUT_NAME = 'LED_layout_output.json';
function findDesktop() {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const cands = [process.argv[2], path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'Desktop')]
        .filter(Boolean);
    let best = null, bestT = -1;
    for (const d of cands) {
        try {
            const t = fs.statSync(path.join(d, IN_NAME)).mtimeMs;
            if (t > bestT) { bestT = t; best = d; }
        } catch (e) { /* not here */ }
    }
    return best || cands[0] || home;
}
const DESKTOP = findDesktop();
const IN_FILE = path.join(DESKTOP, IN_NAME);
const OUT_FILE = path.join(DESKTOP, OUT_NAME);

const PT2MM = 25.4 / 72;
const MM2PT = 72 / 25.4;
const MIN_GAP_MM = 0.2;       // extra gap between circles so cuts never touch
const SCALE = 1000;           // clipper integer units per mm (1 unit = 1 micron)
const FLATTEN_TOL_MM = 0.01;  // max deviation of flattened curve from the true Bezier
const ARC_TOL_MM = 0.005;     // clipper round-join approximation tolerance
const SAFETY_MM = FLATTEN_TOL_MM + ARC_TOL_MM + 0.005; // covers both approximations
const VARIANT_TIME_LIMIT_MS = 60000;

let ClipperLib;
try {
    ClipperLib = require('clipper-lib');
} catch (e) {
    writeFailure('clipper-lib is not installed.\n\nRun LED_Run.bat again - it installs it automatically on first use (needs internet once).');
    console.error('clipper-lib missing.');
    process.exit(1);
}

// ---------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------
function RNG(seed) {
    this.state = Math.abs(Math.floor(seed)) % 4294967296;
    if (this.state === 0) this.state = 1;
}
RNG.prototype.next = function () {
    this.state = (this.state * 1664525 + 1013904223) % 4294967296;
    return this.state / 4294967296;
};
RNG.prototype.range = function (a, b) { return a + (b - a) * this.next(); };
RNG.prototype.intBelow = function (n) { return Math.floor(this.next() * n) % n; };

function dist(a, b) { const dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }
function dist2(ax, ay, bx, by) { const dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }

function shuffleInPlace(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = rng.intBelow(i + 1);
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
}

function writeJSON(file, obj) {
    fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}
function writeFailure(msg, extra) {
    let jobId = null;
    try { jobId = readInput().jobId; } catch (e) { /* ignore */ }
    writeJSON(OUT_FILE, Object.assign({ ok: false, jobId: jobId, message: msg }, extra || {}));
}
function readInput() {
    const txt = fs.readFileSync(IN_FILE, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(txt);
}

// ---------------------------------------------------------------------
// Spatial hash grid for fast "anything near here?" questions
// ---------------------------------------------------------------------
class Grid {
    constructor(cell) { this.cell = cell; this.map = new Map(); }
    key(ix, iy) { return (ix + 100000) * 200003 + (iy + 100000); }
    add(id, x, y) {
        const k = this.key(Math.floor(x / this.cell), Math.floor(y / this.cell));
        let b = this.map.get(k);
        if (!b) { b = []; this.map.set(k, b); }
        b.push(id, x, y);
    }
    // move an entry (used by wobble)
    move(id, ox, oy, nx, ny) {
        const k0 = this.key(Math.floor(ox / this.cell), Math.floor(oy / this.cell));
        const b = this.map.get(k0);
        if (b) {
            for (let i = 0; i < b.length; i += 3) {
                if (b[i] === id) { b.splice(i, 3); break; }
            }
        }
        this.add(id, nx, ny);
    }
    // calls cb(id, x, y) for every entry in cells overlapping the radius
    near(x, y, r, cb) {
        const c = this.cell;
        const x0 = Math.floor((x - r) / c), x1 = Math.floor((x + r) / c);
        const y0 = Math.floor((y - r) / c), y1 = Math.floor((y + r) / c);
        for (let ix = x0; ix <= x1; ix++) {
            for (let iy = y0; iy <= y1; iy++) {
                const b = this.map.get(this.key(ix, iy));
                if (!b) continue;
                for (let i = 0; i < b.length; i += 3) {
                    if (cb(b[i], b[i + 1], b[i + 2]) === false) return false;
                }
            }
        }
        return true;
    }
    anyWithin(x, y, r, skipId) {
        const r2 = r * r;
        let found = false;
        this.near(x, y, r, (id, px, py) => {
            if (id === skipId) return true;
            if (dist2(x, y, px, py) < r2) { found = true; return false; }
            return true;
        });
        return found;
    }
}

// ---------------------------------------------------------------------
// Bezier flattening (adaptive: fine where curvy, few points where flat)
// ---------------------------------------------------------------------
function samePt(a, b) { return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6; }

function distToLine(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L = Math.sqrt(dx * dx + dy * dy);
    if (L < 1e-12) return dist(p, a);
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
}

function flattenCubic(p0, c0, c1, p1, out, depth) {
    const flat = Math.max(distToLine(c0, p0, p1), distToLine(c1, p0, p1));
    if (flat * 0.75 <= FLATTEN_TOL_MM || depth > 14) { out.push(p1); return; }
    // de Casteljau split at t = 0.5
    const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const p01 = m(p0, c0), p12 = m(c0, c1), p23 = m(c1, p1);
    const p012 = m(p01, p12), p123 = m(p12, p23);
    const mid = m(p012, p123);
    flattenCubic(p0, p01, p012, mid, out, depth + 1);
    flattenCubic(mid, p123, p23, p1, out, depth + 1);
}

// ring: array of {a:[x,y], l:[x,y], r:[x,y]} in mm
function flattenRing(ring) {
    const n = ring.length;
    const out = [ring[0].a];
    for (let i = 0; i < n; i++) {
        const A = ring[i], B = ring[(i + 1) % n];
        if (samePt(A.a, A.r) && samePt(B.a, B.l)) out.push(B.a);
        else flattenCubic(A.a, A.r, B.l, B.a, out, 0);
    }
    if (out.length > 1 && samePt(out[0], out[out.length - 1])) out.pop();
    return out;
}

function ringsBounds(rings) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const r of rings) for (const p of r) {
        if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    return { minX, minY, maxX, maxY };
}

// ---------------------------------------------------------------------
// Clipper: exact inset region
// ---------------------------------------------------------------------
function toClip(ring) { return ring.map(p => ({ X: Math.round(p[0] * SCALE), Y: Math.round(p[1] * SCALE) })); }
function fromClip(pathArr) { return pathArr.map(p => [p.X / SCALE, p.Y / SCALE]); }

// Normalise the shape (even-odd, like Illustrator compound holes) and
// shrink it by insetMm. Returns clean rings (outer boundaries + holes).
function insetRings(rings, insetMm) {
    const c = new ClipperLib.Clipper();
    c.AddPaths(rings.map(toClip), ClipperLib.PolyType.ptSubject, true);
    const solution = new ClipperLib.Paths();
    c.Execute(ClipperLib.ClipType.ctUnion, solution,
        ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd);
    const co = new ClipperLib.ClipperOffset(2, ARC_TOL_MM * SCALE);
    co.AddPaths(solution, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon);
    const out = new ClipperLib.Paths();
    co.Execute(out, -(insetMm + SAFETY_MM) * SCALE);
    return out.map(fromClip).filter(r => r.length >= 3);
}

// Even-odd point-in-region test, accelerated with horizontal bands.
class Region {
    constructor(rings) {
        this.rings = rings;
        const edges = [];
        let minY = Infinity, maxY = -Infinity;
        for (const r of rings) {
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
                const a = r[j], b = r[i];
                if (a[1] === b[1]) continue; // horizontal edges never count
                edges.push([a[0], a[1], b[0], b[1]]);
                minY = Math.min(minY, a[1], b[1]); maxY = Math.max(maxY, a[1], b[1]);
            }
        }
        this.empty = edges.length === 0;
        this.minY = minY; this.maxY = maxY;
        const nb = Math.max(16, Math.min(4096, Math.ceil(edges.length / 3)));
        this.nb = nb;
        this.bh = (maxY - minY) / nb || 1;
        this.bands = [];
        for (let i = 0; i < nb; i++) this.bands.push([]);
        for (const e of edges) {
            const lo = Math.min(e[1], e[3]), hi = Math.max(e[1], e[3]);
            const b0 = Math.max(0, Math.floor((lo - minY) / this.bh));
            const b1 = Math.min(nb - 1, Math.floor((hi - minY) / this.bh));
            for (let b = b0; b <= b1; b++) this.bands[b].push(e);
        }
    }
    contains(x, y) {
        if (this.empty || y < this.minY || y > this.maxY) return false;
        let b = Math.floor((y - this.minY) / this.bh);
        if (b >= this.nb) b = this.nb - 1;
        const band = this.bands[b];
        let inside = false;
        for (let i = 0; i < band.length; i++) {
            const e = band[i];
            if ((e[1] > y) !== (e[3] > y) &&
                x < (e[2] - e[0]) * (y - e[1]) / (e[3] - e[1]) + e[0]) inside = !inside;
        }
        return inside;
    }
    bounds() { return ringsBounds(this.rings); }
}


function ringsArea(rings) {
    // clipper output: outer rings and holes have opposite orientation,
    // so the signed sum is the true area
    let a = 0;
    for (const r of rings) {
        for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * r[i][1] - r[i][0] * r[j][1]);
    }
    return Math.abs(a / 2);
}

// Fast static bucket grid (rebuilt every relaxation step).
class BucketGrid {
    constructor(xs, ys, n, cell, bb) {
        this.cell = cell; this.x0 = bb.minX - cell; this.y0 = bb.minY - cell;
        this.nx = Math.max(1, Math.ceil((bb.maxX - bb.minX) / cell) + 3);
        this.ny = Math.max(1, Math.ceil((bb.maxY - bb.minY) / cell) + 3);
        this.head = new Int32Array(this.nx * this.ny).fill(-1);
        this.next = new Int32Array(n);
        for (let i = 0; i < n; i++) {
            const c = this.cellOf(xs[i], ys[i]);
            this.next[i] = this.head[c]; this.head[c] = i;
        }
    }
    cellOf(x, y) {
        let ix = Math.floor((x - this.x0) / this.cell), iy = Math.floor((y - this.y0) / this.cell);
        ix = ix < 0 ? 0 : ix >= this.nx ? this.nx - 1 : ix;
        iy = iy < 0 ? 0 : iy >= this.ny ? this.ny - 1 : iy;
        return iy * this.nx + ix;
    }
    nearest(x, y, xs, ys) {
        let ix = Math.floor((x - this.x0) / this.cell), iy = Math.floor((y - this.y0) / this.cell);
        let best = -1, bd = Infinity;
        for (let ring = 0; ring < Math.max(this.nx, this.ny); ring++) {
            for (let dy = -ring; dy <= ring; dy++) {
                for (let dx = -ring; dx <= ring; dx++) {
                    if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
                    const cx = ix + dx, cy = iy + dy;
                    if (cx < 0 || cy < 0 || cx >= this.nx || cy >= this.ny) continue;
                    for (let k = this.head[cy * this.nx + cx]; k >= 0; k = this.next[k]) {
                        const d = dist2(x, y, xs[k], ys[k]);
                        if (d < bd) { bd = d; best = k; }
                    }
                }
            }
            // anything in a further ring is at least ring*cell away
            if (best >= 0 && Math.sqrt(bd) <= ring * this.cell) break;
        }
        return best;
    }
}

// ---------------------------------------------------------------------
// EVEN FILL: centroidal relaxation (Lloyd's algorithm)
// ---------------------------------------------------------------------
// Every LED ends up owning an equally sized patch of the shape, so the
// spread is even everywhere - edges are never denser than the middle.
// cvtRegion   : area the LEDs share out (shape shrunk by edge clearance)
// legalRegion : where LED centres may actually sit (clearance + radius)
function relaxEven(cvtRegion, legalRegion, N, rng, deadline, exclusions) {
    const excl = exclusions || [];
    const excluded = (x, y) => { for (const e of excl) if (dist2(x, y, e[0], e[1]) < e[2] * e[2]) return true; return false; };
    const A = ringsArea(cvtRegion.rings);
    const bb = cvtRegion.bounds();
    let h = Math.sqrt(A / (N * 30));
    h = Math.max(h, Math.sqrt(A / 300000));
    const sx = [], sy = [], sl = [];
    for (let y = bb.minY + h / 2; y <= bb.maxY; y += h) {
        for (let x = bb.minX + h / 2; x <= bb.maxX; x += h) {
            if (!cvtRegion.contains(x, y) || excluded(x, y)) continue;
            sx.push(x); sy.push(y); sl.push(legalRegion.contains(x, y) ? 1 : 0);
        }
    }
    const legalIdx = [];
    for (let i = 0; i < sl.length; i++) if (sl[i]) legalIdx.push(i);
    if (legalIdx.length === 0) return [];
    const lx = new Float64Array(legalIdx.length), ly = new Float64Array(legalIdx.length);
    legalIdx.forEach((s, i) => { lx[i] = sx[s]; ly[i] = sy[s]; });
    const legalGrid = new BucketGrid(lx, ly, lx.length, h * 3, bb);

    // start from a honeycomb at the even spacing (rotation + shift from
    // the seed), trimmed/topped up to exactly N. Relaxation then only has
    // to settle the edges, which gives much more uniform spacing than a
    // random start.
    const n = Math.min(N, legalIdx.length);
    const sEst = Math.sqrt(A / (n * 0.866));
    const init = [];
    {
        const ang = rng.range(0, Math.PI / 3), ca = Math.cos(ang), sa = Math.sin(ang);
        const px = rng.next(), py = rng.next();
        const cx = (bb.minX + bb.maxX) / 2, cy = (bb.minY + bb.maxY) / 2;
        const Rr = Math.sqrt(dist2(bb.minX, bb.minY, bb.maxX, bb.maxY)) / 2 + sEst * 2;
        const rowH = sEst * 0.866;
        for (let row = -Math.ceil(Rr / rowH); row <= Math.ceil(Rr / rowH); row++) {
            for (let col = -Math.ceil(Rr / sEst); col <= Math.ceil(Rr / sEst); col++) {
                const lx0 = (col + px + ((row & 1) ? 0.5 : 0)) * sEst, ly0 = (row + py) * rowH;
                const x = cx + lx0 * ca - ly0 * sa, y = cy + lx0 * sa + ly0 * ca;
                if (legalRegion.contains(x, y) && !excluded(x, y)) init.push([x, y]);
            }
        }
        shuffleInPlace(init, rng);
        if (init.length > n) init.length = n;
        shuffleInPlace(legalIdx, rng);
        for (let k = 0; init.length < n && k < legalIdx.length; k++) init.push([sx[legalIdx[k]], sy[legalIdx[k]]]);
    }
    const gx = new Float64Array(n), gy = new Float64Array(n);
    for (let i = 0; i < n; i++) { gx[i] = init[i][0]; gy[i] = init[i][1]; }
    const sumX = new Float64Array(n), sumY = new Float64Array(n), cnt = new Int32Array(n);
    const S = sx.length;

    for (let it = 0; it < 250; it++) {
        if (Date.now() > deadline) break;
        const grid = new BucketGrid(gx, gy, n, sEst, bb);
        sumX.fill(0); sumY.fill(0); cnt.fill(0);
        for (let s = 0; s < S; s++) {
            const g = grid.nearest(sx[s], sy[s], gx, gy);
            sumX[g] += sx[s]; sumY[g] += sy[s]; cnt[g]++;
        }
        let maxMove = 0;
        for (let g = 0; g < n; g++) {
            let nx, ny;
            if (cnt[g] === 0) {
                // starved generator: jump to a random legal sample
                const k = rng.intBelow(lx.length); nx = lx[k]; ny = ly[k];
            } else {
                nx = sumX[g] / cnt[g]; ny = sumY[g] / cnt[g];
                if (!legalRegion.contains(nx, ny) || excluded(nx, ny)) {
                    const k = legalGrid.nearest(nx, ny, lx, ly);
                    nx = lx[k]; ny = ly[k];
                }
            }
            maxMove = Math.max(maxMove, Math.sqrt(dist2(nx, ny, gx[g], gy[g])));
            gx[g] = nx; gy[g] = ny;
        }
        if (it > 20 && maxMove < sEst * 0.002) break;
    }
    const pts = [];
    for (let g = 0; g < n; g++) pts.push([gx[g], gy[g]]);
    return pts;
}

// Push apart any pair closer than minSep (only needed when the shape is
// nearly full). Returns the smallest remaining centre distance.
function separate(pts, minSep, legal, iters) {
    let worst = Infinity;
    for (let it = 0; it < iters; it++) {
        const grid = new Grid(minSep);
        pts.forEach((p, i) => grid.add(i, p[0], p[1]));
        let bad = 0; worst = Infinity;
        for (let i = 0; i < pts.length; i++) {
            grid.near(pts[i][0], pts[i][1], minSep, (j, x, y) => {
                if (j <= i) return;
                const d = Math.sqrt(dist2(pts[i][0], pts[i][1], x, y));
                worst = Math.min(worst, d);
                if (d >= minSep) return;
                bad++;
                const push = (minSep - d) / 2 + 0.01;
                const ux = d > 1e-9 ? (pts[i][0] - x) / d : 1, uy = d > 1e-9 ? (pts[i][1] - y) / d : 0;
                const ai = [pts[i][0] + ux * push, pts[i][1] + uy * push];
                const aj = [pts[j][0] - ux * push, pts[j][1] - uy * push];
                if (legal.contains(ai[0], ai[1])) pts[i] = ai;
                if (legal.contains(aj[0], aj[1])) pts[j] = aj;
            });
        }
        if (bad === 0) break;
    }
    if (pts.length < 2) return Infinity;
    const grid = new Grid(minSep * 2);
    pts.forEach((p, i) => grid.add(i, p[0], p[1]));
    worst = Infinity;
    pts.forEach((p, i) => grid.near(p[0], p[1], minSep * 2, (j, x, y) => {
        if (j !== i) worst = Math.min(worst, Math.sqrt(dist2(p[0], p[1], x, y)));
    }));
    return worst;
}

// ---------------------------------------------------------------------
// WOBBLE (rejection sampling; never produces an illegal position)
// ---------------------------------------------------------------------
function applyWobble(base, wobble, region, minSep, maxDist, nbRadius, rng, tries) {
    const n = base.length;
    const out = base.map(p => [p[0], p[1]]);
    if (wobble <= 0 || n === 0) return out;
    const grid = new Grid(Math.max(minSep, 1));
    for (let i = 0; i < n; i++) grid.add(i, out[i][0], out[i][1]);

    // pairs that are neighbours now must stay within cable reach
    const limited = isFinite(maxDist);
    const nbs = [];
    if (limited) {
        const nbGrid = new Grid(nbRadius);
        for (let i = 0; i < n; i++) nbGrid.add(i, base[i][0], base[i][1]);
        const nb2 = nbRadius * nbRadius;
        for (let i = 0; i < n; i++) {
            const L = [];
            nbGrid.near(base[i][0], base[i][1], nbRadius, (id, x, y) => {
                if (id !== i && dist2(base[i][0], base[i][1], x, y) <= nb2) L.push(id);
            });
            nbs.push(L);
        }
    }
    const order = shuffleInPlace(base.map((_, i) => i), rng);
    const md2 = maxDist * maxDist;
    for (const idx of order) {
        for (let t = 0; t < tries; t++) {
            const a = rng.range(0, Math.PI * 2);
            const r = wobble * Math.sqrt(rng.next());
            const nx = base[idx][0] + r * Math.cos(a), ny = base[idx][1] + r * Math.sin(a);
            if (!region.contains(nx, ny)) continue;
            if (grid.anyWithin(nx, ny, minSep, idx)) continue;
            if (limited) {
                let ok = true;
                for (const q of nbs[idx]) if (dist2(out[q][0], out[q][1], nx, ny) > md2) { ok = false; break; }
                if (!ok) continue;
            }
            grid.move(idx, out[idx][0], out[idx][1], nx, ny);
            out[idx][0] = nx; out[idx][1] = ny;
            break;
        }
    }
    return out;
}

// ---------------------------------------------------------------------
// CABLE RULES
// ---------------------------------------------------------------------
// A cable segment is allowed only if it is short enough AND it never
// passes through (or touches) any circle other than its own two ends.
class CableRules {
    constructor(pts, maxDist, clearR, outline) {
        this.pts = pts; this.maxDist = maxDist; this.clearR = clearR;
        // outline edges (shape boundary incl. holes): the cable may not cross them
        this.ocell = 10;
        this.oedges = [];
        this.ogrid = new Map();
        for (const r of (outline || [])) {
            for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
                const e = [r[j][0], r[j][1], r[i][0], r[i][1]];
                const id = this.oedges.push(e) - 1;
                const x0 = Math.floor(Math.min(e[0], e[2]) / this.ocell), x1 = Math.floor(Math.max(e[0], e[2]) / this.ocell);
                const y0 = Math.floor(Math.min(e[1], e[3]) / this.ocell), y1 = Math.floor(Math.max(e[1], e[3]) / this.ocell);
                for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
                    const k = x * 1000003 + y; let a = this.ogrid.get(k); if (!a) { a = []; this.ogrid.set(k, a); } a.push(id);
                }
            }
        }
        this.grid = new Grid(Math.max(clearR * 2, 1));
        pts.forEach((p, i) => this.grid.add(i, p[0], p[1]));
        this.cache = new Map();
    }
    ok(a, b) {
        if (a === b) return false;
        const key = a < b ? a * 1000003 + b : b * 1000003 + a;
        let v = this.cache.get(key);
        if (v !== undefined) return v;
        v = this._check(a, b);
        this.cache.set(key, v);
        return v;
    }
    _check(a, b) {
        const P = this.pts[a], Q = this.pts[b];
        const dx = Q[0] - P[0], dy = Q[1] - P[1];
        const L2 = dx * dx + dy * dy;
        if (Math.sqrt(L2) > this.maxDist + 1e-9) return false;
        if (this.oedges.length && this._leavesShape(P, Q)) return false;
        const R = this.clearR, R2 = R * R;
        // walk the segment and query circles near it
        const L = Math.sqrt(L2);
        const steps = Math.max(1, Math.ceil(L / (R * 2)));
        const seen = new Set();
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            const cx = P[0] + dx * t, cy = P[1] + dy * t;
            const hit = !this.grid.near(cx, cy, R * 2, (id, x, y) => {
                if (id === a || id === b || seen.has(id)) return true;
                seen.add(id);
                let u = L2 > 0 ? ((x - P[0]) * dx + (y - P[1]) * dy) / L2 : 0;
                u = u < 0 ? 0 : u > 1 ? 1 : u;
                if (dist2(x, y, P[0] + u * dx, P[1] + u * dy) < R2) return false; // blocked
                return true;
            });
            if (hit) return false;
        }
        return true;
    }
}

CableRules.prototype._leavesShape = function (P, Q) {
    // walk the grid cells the segment passes through (DDA) and test edges
    const c = this.ocell;
    let x = Math.floor(P[0] / c), y = Math.floor(P[1] / c);
    const xe = Math.floor(Q[0] / c), ye = Math.floor(Q[1] / c);
    const dx = Q[0] - P[0], dy = Q[1] - P[1];
    const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(c / dx) : Infinity, tdy = dy !== 0 ? Math.abs(c / dy) : Infinity;
    let tmx = dx !== 0 ? ((sx > 0 ? (x + 1) * c - P[0] : P[0] - x * c) / Math.abs(dx)) : Infinity;
    let tmy = dy !== 0 ? ((sy > 0 ? (y + 1) * c - P[1] : P[1] - y * c) / Math.abs(dy)) : Infinity;
    const tested = new Set();
    for (let guard = 0; guard < 100000; guard++) {
        const arr = this.ogrid.get(x * 1000003 + y);
        if (arr) for (const id of arr) {
            if (tested.has(id)) continue; tested.add(id);
            const e = this.oedges[id];
            if (segCross(P, Q, [e[0], e[1]], [e[2], e[3]])) return true;
        }
        if (x === xe && y === ye) break;
        if (tmx < tmy) { tmx += tdx; x += sx; } else { tmy += tdy; y += sy; }
    }
    return false;
};

function buildAdjacency(pts, rules, radius) {
    const n = pts.length;
    const grid = new Grid(Math.max(radius, 1));
    pts.forEach((p, i) => grid.add(i, p[0], p[1]));
    const r2 = radius * radius;
    const adj = [];
    for (let i = 0; i < n; i++) {
        const L = [];
        grid.near(pts[i][0], pts[i][1], radius, (id, x, y) => {
            if (id === i) return;
            const d2 = dist2(pts[i][0], pts[i][1], x, y);
            if (d2 <= r2 && rules.ok(i, id)) L.push({ idx: id, d: d2 });
        });
        L.sort((a, b) => a.d - b.d);
        adj.push(L.map(o => o.idx));
    }
    return adj;
}

function segCross(a, b, c, d) {
    // proper intersection of segments ab and cd (shared endpoints don't count)
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// list of crossing segment pairs [i, j] (segment i = route[i] -> route[i+1])
function findCrossings(route, pts, cell) {
    const n = route.length;
    const grid = new Map();
    const key = (ix, iy) => ix * 1000003 + iy;
    const segCells = [];
    for (let i = 0; i + 1 < n; i++) {
        const a = pts[route[i]], b = pts[route[i + 1]];
        const x0 = Math.floor(Math.min(a[0], b[0]) / cell), x1 = Math.floor(Math.max(a[0], b[0]) / cell);
        const y0 = Math.floor(Math.min(a[1], b[1]) / cell), y1 = Math.floor(Math.max(a[1], b[1]) / cell);
        const cells = [];
        for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
            const k = key(x, y); cells.push(k);
            let arr = grid.get(k); if (!arr) { arr = []; grid.set(k, arr); } arr.push(i);
        }
        segCells.push(cells);
    }
    const found = [], seen = new Set();
    for (let i = 0; i + 1 < n; i++) {
        for (const k of segCells[i]) {
            for (const j of grid.get(k)) {
                if (j <= i + 1) continue; // adjacent segments share a point
                const pk = i * 1000003 + j;
                if (seen.has(pk)) continue; seen.add(pk);
                if (segCross(pts[route[i]], pts[route[i + 1]], pts[route[j]], pts[route[j + 1]])) found.push([i, j]);
            }
        }
    }
    return found;
}

// 2-opt: shortens the route AND untangles crossings. Only ever creates
// segments that obey the cable rules. Start and end LED never move.
function improveRoute(route, pts, rules, lockEnd, deadline) {
    const n = route.length;
    if (n < 4) return route;
    const pos = new Int32Array(pts.length);
    const reverse = (i, j) => { // reverse route[i+1..j]
        let lo = i + 1, hi = j;
        while (lo < hi) { const t = route[lo]; route[lo] = route[hi]; route[hi] = t; lo++; hi--; }
    };
    // (a) untangle every crossing we can
    for (let pass = 0; pass < 50; pass++) {
        if (Date.now() > deadline) break;
        const cross = findCrossings(route, pts, rules.maxDist < Infinity ? rules.maxDist : 50);
        if (cross.length === 0) break;
        let fixed = 0;
        for (const [i, j] of cross) {
            // re-check: earlier reversals may have changed these segments
            if (!segCross(pts[route[i]], pts[route[i + 1]], pts[route[j]], pts[route[j + 1]])) continue;
            if (rules.ok(route[i], route[j]) && rules.ok(route[i + 1], route[j + 1])) { reverse(i, j); fixed++; }
        }
        if (fixed === 0) break;
    }
    // (b) neighbour-list 2-opt for a shorter, tidier cable
    const jMax = lockEnd ? n - 1 : n;
    for (let pass = 0; pass < 10; pass++) {
        if (Date.now() > deadline) break;
        for (let k = 0; k < n; k++) pos[route[k]] = k;
        let improved = false;
        for (let i = 0; i < n - 2; i++) {
            const a = route[i], b = route[i + 1];
            const dab = dist(pts[a], pts[b]);
            for (let j = i + 2; j < jMax; j++) {
                const c = route[j];
                const hasNext = j + 1 < n;
                const e1 = dist(pts[a], pts[c]);
                if (e1 >= dab + (hasNext ? dist(pts[c], pts[route[j + 1]]) : 0)) continue;
                const oldLen = dab + (hasNext ? dist(pts[c], pts[route[j + 1]]) : 0);
                const e2 = hasNext ? dist(pts[b], pts[route[j + 1]]) : 0;
                if (e1 + e2 >= oldLen - 1e-9) continue;
                if (!rules.ok(a, c)) continue;
                if (hasNext && !rules.ok(b, route[j + 1])) continue;
                reverse(i, j);
                improved = true;
                break;
            }
        }
        if (!improved) break;
    }
    return route;
}

function routeLength(route, pts) { let L = 0; for (let i = 0; i + 1 < route.length; i++) L += dist(pts[route[i]], pts[route[i + 1]]); return L; }
function routeMaxSeg(route, pts) { let m = 0; for (let i = 0; i + 1 < route.length; i++) m = Math.max(m, dist(pts[route[i]], pts[route[i + 1]])); return m; }

function validRoute(route, pts, rules) {
    const n = pts.length;
    if (!route || route.length !== n) return false;
    const seen = new Uint8Array(n);
    for (const r of route) { if (seen[r]) return false; seen[r] = 1; }
    for (let i = 0; i + 1 < n; i++) if (!rules._check(route[i], route[i + 1])) return false;
    return true;
}

function cornerXY(b, c) {
    if (c === 'TL') return [b.minX, b.maxY];
    if (c === 'TR') return [b.maxX, b.maxY];
    if (c === 'BL') return [b.minX, b.minY];
    return [b.maxX, b.minY];
}
function nearestToCorner(pts, b, corner, exclude) {
    const c = cornerXY(b, corner);
    let best = -1, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
        if (i === exclude) continue;
        const d = dist2(pts[i][0], pts[i][1], c[0], c[1]);
        if (d < bd) { bd = d; best = i; }
    }
    return best;
}

function candidateStarts(pts, adj, rng, deadEnds) {
    const n = pts.length;
    const starts = deadEnds.slice();
    const byDeg = pts.map((_, i) => i).sort((a, b) => adj[a].length - adj[b].length);
    starts.push(byDeg[0]); if (n > 1) starts.push(byDeg[1]);
    let iMinX = 0, iMaxX = 0, iMinY = 0, iMaxY = 0;
    for (let i = 1; i < n; i++) {
        if (pts[i][0] < pts[iMinX][0]) iMinX = i; if (pts[i][0] > pts[iMaxX][0]) iMaxX = i;
        if (pts[i][1] < pts[iMinY][1]) iMinY = i; if (pts[i][1] > pts[iMaxY][1]) iMaxY = i;
    }
    starts.push(iMinX, iMaxX, iMinY, iMaxY);
    for (let r = 0; r < 6; r++) starts.push(rng.intBelow(n));
    return starts.filter((v, i) => starts.indexOf(v) === i);
}

// returns { route, crossings } or { fail, ... }
function buildRoute(pts, opt, rng, startIdx, endIdx, deadline) {
    const n = pts.length;
    const rules = new CableRules(pts, opt.maxDist, opt.clearR, opt.outline);
    // try local connections first (tidy cable), widen if needed
    const radii = [];
    for (const k of [2.3, 3.5, 6]) radii.push(Math.min(opt.maxDist, opt.spacing * k));
    if (isFinite(opt.maxDist)) radii.push(opt.maxDist);
    const uniq = radii.filter((r, i) => radii.indexOf(r) === i).sort((a, b) => a - b);

    let lastFail = null;
    for (const radius of uniq) {
        if (Date.now() > deadline) return { fail: 'timeout' };
        const adj = buildAdjacency(pts, rules, radius);
        const feas = routeFeasibility(adj, startIdx, endIdx);
        if (!feas.ok) { lastFail = { fail: feas.reason, islands: feas.islands, deadEnds: feas.deadEnds, deadList: feas.deadList }; continue; }

        const maxIter = Math.max(200000, n * 400);
        let best = null, bestScore = Infinity, tries = 0;
        const consider = (r, reversed) => {
            if (!r) return;
            if (reversed) r.reverse();
            r = improveRoute(r, pts, rules, endIdx >= 0 || reversed, deadline + 5000);
            const cross = findCrossings(r, pts, Math.max(radius, 1)).length;
            const score = cross * 1e9 + routeLength(r, pts);
            if (score < bestScore) { bestScore = score; best = { route: r.slice(), crossings: cross }; }
        };
        const starts = startIdx >= 0 ? [startIdx] : endIdx >= 0 ? [endIdx] : candidateStarts(pts, adj, rng, feas.deadEnds || []);
        const attempts = opt.avoidCrossings ? 12 : 4;
        for (let k = 0; tries < attempts && Date.now() < deadline && k < attempts * 3; k++) {
            const s = starts[k % starts.length];
            let r;
            if (startIdx >= 0) r = posaRoute(n, adj, startIdx, endIdx, rng, maxIter, deadline);
            else if (endIdx >= 0) r = posaRoute(n, adj, endIdx, -1, rng, maxIter, deadline);
            else r = posaRoute(n, adj, s, -1, rng, maxIter, deadline);
            if (!r) continue;
            tries++;
            consider(r, startIdx < 0 && endIdx >= 0);
            if (best && best.crossings === 0 && tries >= 2) break;
        }
        if (!best) { lastFail = { fail: 'search' }; continue; }
        if (opt.avoidCrossings && best.crossings > 0) { lastFail = { fail: 'crossings', crossings: best.crossings }; continue; }
        if (!validRoute(best.route, pts, rules)) { lastFail = { fail: 'invalid' }; continue; }
        return best;
    }
    return lastFail || { fail: 'search' };
}

// ---------------------------------------------------------------------
// LAYOUT GENERATION for one variant
// ---------------------------------------------------------------------
const HEX = Math.sqrt(3) / 2;

function generateVariant(ctx, seed) {
    const P = ctx.params;
    const report = { counts: [], failedRoutes: 0, lastFail: null, islands: 0, deadEnds: 0, crossings: 0 };
    const deadline = Date.now() + VARIANT_TIME_LIMIT_MS;
    const minSep = P.diameterMm + MIN_GAP_MM;
    const unlimited = !(P.centerMm > 0);
    const maxDist = unlimited ? Infinity : P.centerMm;
    const clearR = P.diameterMm / 2 + MIN_GAP_MM;
    const area = ctx.cvtArea;

    const attemptLayout = (N, spacingGuess, attemptNo) => {
        report.counts.push(N);
        const exclusions = [];
        for (let round = 0; round < 6; round++) {
            const base = relaxEven(ctx.cvtRegion, ctx.region, N, new RNG(seed * 97 + attemptNo * 7919 + 1), deadline, exclusions);
            if (base.length < N) { report.tooFull = true; return null; }
            const minD = separate(base, minSep, ctx.region, 60);
            if (minD < minSep - 1e-6) { report.tooFull = true; return null; }
            const spacing = meanNN(base) || spacingGuess;
            let dead = null;
            for (const wf of [1.0, 0.6, 0.3, 0.0]) {
                if (Date.now() > deadline) { report.timeout = true; return null; }
                const wMm = P.wobbleMm * wf;
                const rng = new RNG(seed + attemptNo * 131 + Math.round(wf * 10));
                const pts = applyWobble(base, wMm, ctx.region, minSep, maxDist, Math.min(spacing * 1.3, maxDist), rng, 30);
                if (pts.length === 1) return { points: pts, route: [0], spacingMm: spacing, wobbleMm: 0, crossings: 0, tipsLeftEmpty: 0 };
                let si = -1, ei = -1;
                if (P.startCorner !== 'auto') si = nearestToCorner(pts, ctx.bounds, P.startCorner, -1);
                if (P.endCorner !== 'auto') ei = nearestToCorner(pts, ctx.bounds, P.endCorner, si);
                const r = buildRoute(pts, { maxDist, clearR, spacing, avoidCrossings: P.avoidCrossings !== false, outline: ctx.outline },
                    new RNG(seed + 15485863 + attemptNo), si, ei, deadline);
                if (r.route) return { points: pts, route: r.route, spacingMm: spacing, wobbleMm: wMm, crossings: r.crossings, tipsLeftEmpty: exclusions.length };
                report.failedRoutes++;
                report.lastFail = r.fail;
                if (r.islands) report.islands = Math.max(report.islands, r.islands);
                if (r.deadEnds) report.deadEnds = Math.max(report.deadEnds, r.deadEnds);
                if (r.crossings) report.crossings = r.crossings;
                if (r.fail === 'deadends' && r.deadList && wf === 0) dead = r.deadList.map(i => base[i] ? pts[i] : null).filter(Boolean);
                if (wMm <= 0) break;
            }
            // Tips where one LED can't be passed through: leave them empty and
            // let the relaxation spread those LEDs over the rest of the shape.
            if (!dead || dead.length === 0) break;
            for (const d of dead) exclusions.push([d[0], d[1], spacing * 0.75]);
        }
        return null;
    };

    if (!P.useCount) {
        // ---------- AUTO: spacing comes from the cable distance ----------
        for (const sc of [0.92, 0.82, 0.72, 0.62]) {
            let s = (P.centerMm - P.wobbleMm) * sc;
            s = Math.max(s, minSep * 1.05, P.centerMm * 0.35);
            const N = Math.max(1, Math.round(area / (HEX * s * s)));
            const res = attemptLayout(N, s, report.counts.length);
            if (res) return res;
            if (report.tooFull) break;
        }
        return { fail: true, report };
    }

    // ---------- EXACT COUNT ----------
    const N = P.count;
    report.requestedCount = N;
    const evenS = Math.sqrt(area / (HEX * N));
    report.evenSpacingMm = evenS;
    report.maxPossibleCount = Math.floor(area / (HEX * minSep * minSep));
    if (!unlimited && evenS > maxDist * 1.02) {
        report.needMoreDistance = true;
        report.countAtCurrentDistance = Math.ceil(area / (HEX * maxDist * maxDist));
        return { fail: true, report };
    }
    for (let a = 0; a < 3; a++) {
        const res = attemptLayout(N, evenS, a);
        if (res) return res;
        if (report.tooFull) break;
    }
    return { fail: true, report };
}

function meanNN(pts) {
    if (pts.length < 2) return 0;
    const bb = ringsBounds([pts]);
    const cell = Math.sqrt(((bb.maxX - bb.minX + 1) * (bb.maxY - bb.minY + 1)) / pts.length);
    const grid = new Grid(cell);
    pts.forEach((p, i) => grid.add(i, p[0], p[1]));
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
        let best = Infinity, r = cell;
        while (best === Infinity && r < cell * 64) {
            grid.near(pts[i][0], pts[i][1], r, (j, x, y) => { if (j !== i) best = Math.min(best, dist2(pts[i][0], pts[i][1], x, y)); });
            r *= 2;
        }
        sum += Math.sqrt(best);
    }
    return sum / pts.length;
}

// ---------------------------------------------------------------------
// FAILURE MESSAGE (plain language, shown by LED_Import.jsx)
// ---------------------------------------------------------------------
function failureMessage(rep, P) {
    if (rep.requestedCount !== undefined && (rep.tooFull || rep.maxPossibleCount < rep.requestedCount)) {
        return 'The shape cannot hold ' + rep.requestedCount + ' circles evenly.\n\n' +
            'With diameter ' + P.diameterMm + ' mm and edge clearance ' + P.edgeMm + ' mm, roughly ' +
            rep.maxPossibleCount + ' circles fit at most.\n\nReduce the LED count, the diameter, or the edge clearance.';
    }
    if (rep.needMoreDistance) {
        const needed = Math.ceil(rep.evenSpacingMm * 1.1);
        return 'MORE CABLE DISTANCE NEEDED\n\n' +
            'Spread evenly over this shape, ' + rep.requestedCount + ' LEDs sit about ' + rep.evenSpacingMm.toFixed(1) +
            ' mm apart, but the LED Center Distance is only ' + P.centerMm + ' mm.\n\n' +
            'Either:\n- increase LED Center Distance to at least ~' + needed + ' mm (or 0 = unlimited), or\n' +
            '- increase the LED count to at least ' + rep.countAtCurrentDistance + '.';
    }
    if (rep.tooFull) {
        return 'The shape is too small or narrow for diameter ' + P.diameterMm + ' mm + edge clearance ' + P.edgeMm +
            ' mm at this density.\n\nTry a smaller diameter, edge clearance, or a larger LED Center Distance.';
    }
    const lim = P.centerMm > 0 ? ('with every segment <= ' + P.centerMm + ' mm') : 'without passing through other LEDs';
    let m = 'Could not route one continuous cable through all LEDs ' + lim + '.\n\n';
    if (rep.lastFail === 'crossings') {
        m += 'Reason: every cable found crosses itself at least ' + rep.crossings + ' time(s).\n\n' +
            'Try: untick "Avoid cable crossings", use another seed, or allow a larger LED Center Distance.';
    } else if (rep.lastFail === 'islands') {
        m += 'Reason: the LEDs fall into ' + rep.islands + ' separate groups the cable cannot bridge. ' +
            'Usually thin parts of the shape: spread evenly, LEDs there sit in single file further apart ' +
            'than the cable reaches (or a neck is narrower than 2x edge clearance + LED diameter).\n\n' +
            'Try: more LEDs, a larger LED Center Distance (or 0), or a smaller edge clearance.';
    } else if (rep.lastFail === 'deadends') {
        m += 'Reason: ' + rep.deadEnds + ' LEDs sit in tips or single-file arms where the cable could reach them ' +
            'but not continue - and one cable only has two ends.\n\n' +
            'Try: more LEDs (so thin parts get two rows), a larger LED Center Distance, or less wobble.';
    } else if (rep.timeout) {
        m += 'Reason: the search ran out of time.\n\nTry: less wobble, another seed, or fewer LEDs.';
    } else {
        m += 'Try: a larger LED Center Distance, less wobble, a smaller edge clearance, or another seed.';
    }
    m += '\n\nLED counts tried: ' + rep.counts.join(', ') + '\nFailed routing attempts: ' + rep.failedRoutes;
    return m;
}

function routeFeasibility(adj, startIdx, endIdx) {
    const n = adj.length;
    if (n <= 1) return { ok: true };
    // connectivity
    const seen = new Uint8Array(n);
    const stack = [0]; seen[0] = 1; let cnt = 1;
    while (stack.length) {
        const u = stack.pop();
        for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; cnt++; stack.push(v); }
    }
    if (cnt < n) {
        // count islands for the report
        let islands = 1;
        for (let s = 0; s < n; s++) {
            if (seen[s]) continue;
            islands++;
            const st = [s]; seen[s] = 1;
            while (st.length) { const u = st.pop(); for (const v of adj[u]) if (!seen[v]) { seen[v] = 1; st.push(v); } }
        }
        return { ok: false, reason: 'islands', islands };
    }
    // dead ends: a LED with only one neighbour MUST be a cable end
    const dead = [];
    for (let i = 0; i < n; i++) if (adj[i].length === 1) dead.push(i);
    const pinned = [startIdx, endIdx].filter(x => x >= 0);
    let freeEnds = 2 - pinned.length;
    const unpinnedDead = dead.filter(d => pinned.indexOf(d) < 0);
    if (unpinnedDead.length > freeEnds) return { ok: false, reason: 'deadends', deadEnds: dead.length, deadList: unpinnedDead };
    return { ok: true, deadEnds: dead };
}
function posaRoute(n, adj, startIdx, endIdx, rng, maxIter, deadline) {
    const path = [startIdx];
    const pos = new Int32Array(n).fill(-1);
    pos[startIdx] = 0;
    let iter = 0;
    const adjSets = adj.map(L => L);
    const isAdj = (a, b) => adjSets[a].indexOf(b) >= 0;
    const unvisitedDeg = v => { let c = 0; for (const w of adj[v]) if (pos[w] < 0) c++; return c; };
    const need = endIdx >= 0 ? n - 1 : n; // nodes to place before the pinned end
    const rotateTail = () => {
        const last = path.length - 1;
        const tail = path[last];
        const opts = [];
        for (const v of adj[tail]) { const p = pos[v]; if (p >= 0 && p < last - 1) opts.push(p); }
        if (opts.length === 0) return false;
        const i = opts[rng.intBelow(opts.length)];
        let lo = i + 1, hi = last;
        while (lo < hi) {
            const t = path[lo]; path[lo] = path[hi]; path[hi] = t;
            pos[path[lo]] = lo; pos[path[hi]] = hi; lo++; hi--;
        }
        return true;
    };
    while (iter++ < maxIter) {
        if ((iter & 1023) === 0 && Date.now() > deadline) return null;
        if (path.length >= need) {
            if (endIdx < 0) return path;
            if (isAdj(path[path.length - 1], endIdx)) { path.push(endIdx); return path; }
            if (!rotateTail()) return null;
            continue;
        }
        const tail = path[path.length - 1];
        let best = -1, bestDeg = Infinity, ties = 0;
        for (const v of adj[tail]) {
            if (pos[v] >= 0 || v === endIdx) continue;
            const d = unvisitedDeg(v);
            if (d < bestDeg) { bestDeg = d; best = v; ties = 1; }
            else if (d === bestDeg && rng.intBelow(++ties) === 0) best = v;
        }
        if (best >= 0) { pos[best] = path.length; path.push(best); continue; }
        if (!rotateTail()) return null;
    }
    return null;
}
function main() {
    const t0 = Date.now();
    let input;
    try { input = readInput(); }
    catch (e) {
        writeFailure('Could not read ' + IN_FILE + ':\n' + e.message + '\n\nRun LED_Export.jsx in Illustrator first.');
        console.error('Could not read ' + IN_FILE + ': ' + e.message);
        return;
    }
    const P = input.params;
    console.log('');
    console.log('  LED Layout Generator - Node engine');
    console.log('  ----------------------------------');
    console.log('  Document : ' + input.docName);
    console.log('  Files in : ' + DESKTOP);
    console.log('  Mode     : ' + (P.useCount ? ('exact count (' + P.count + ')') : 'auto fill'));
    console.log('  Cable    : ' + (P.centerMm > 0 ? ('max ' + P.centerMm + ' mm between LEDs') : 'unlimited') + (P.avoidCrossings !== false ? ', no crossings' : ', crossings allowed'));
    console.log('  Variants : ' + P.variants);
    console.log('');

    // shape -> mm, flattened
    const ringsMm = input.paths.map(ring => flattenRing(ring.map(pp => ({
        a: [pp.a[0] * PT2MM, pp.a[1] * PT2MM],
        l: [pp.l[0] * PT2MM, pp.l[1] * PT2MM],
        r: [pp.r[0] * PT2MM, pp.r[1] * PT2MM]
    })))).filter(r => r.length >= 3);

    if (ringsMm.length === 0) { writeFailure('The exported shape has no usable outline.'); return; }

    if (!(P.centerMm > 0) && !P.useCount) {
        writeFailure('LED Center Distance 0 means unlimited cable, which needs an exact LED count.\n\nTick "Set exact LED count" in LED_Export and try again.');
        console.log('  Distance 0 needs an exact LED count.');
        return;
    }
    const bounds = ringsBounds(ringsMm);
    const legal = insetRings(ringsMm, P.edgeMm + P.diameterMm / 2);
    const region = new Region(legal);
    const cvtRings = insetRings(ringsMm, P.edgeMm);
    const cvtRegion = new Region(cvtRings);
    const ctx = { params: P, bounds, region, cvtRegion, cvtArea: ringsArea(cvtRings), outline: ringsMm };
    if (region.empty) {
        writeFailure('The usable area is empty: the shape is too small or narrow for diameter ' + P.diameterMm +
            ' mm + edge clearance ' + P.edgeMm + ' mm.\n\n(Every LED centre needs ' + (P.edgeMm + P.diameterMm / 2) +
            ' mm clearance from every edge, including holes.)\n\nTry a smaller diameter or edge clearance.');
        console.log('  Usable area is empty - nothing fits.');
        return;
    }
    console.log('  Shape flattened (' + ringsMm.reduce((a, r) => a + r.length, 0) + ' pts), inset region ready.');

    const variants = [];
    const failures = [];
    for (let v = 0; v < P.variants; v++) {
        const seed = P.seed + v;
        const vt = Date.now();
        process.stdout.write('  Variant ' + (v + 1) + ' (seed ' + seed + ') ... ');
        const res = generateVariant(ctx, seed);
        const secs = ((Date.now() - vt) / 1000).toFixed(1);
        if (res.fail) {
            console.log('FAILED (' + secs + ' s)');
            failures.push({ seed, report: res.report });
            continue;
        }
        const ordered = res.route.map(i => res.points[i]);
        const cable = res.route.length > 1 ? routeLength(res.route, res.points) : 0;
        const maxSeg = res.route.length > 1 ? routeMaxSeg(res.route, res.points) : 0;
        console.log(ordered.length + ' LEDs, cable ' + (cable / 1000).toFixed(2) + ' m' + (res.crossings ? ', ' + res.crossings + ' crossing(s)' : '') + (res.tipsLeftEmpty ? ', ' + res.tipsLeftEmpty + ' thin tip(s) left empty' : '') + ' (' + secs + ' s)');
        variants.push({
            seed,
            points: ordered.map(p => [+(p[0] * MM2PT).toFixed(3), +(p[1] * MM2PT).toFixed(3)]),
            ledCount: ordered.length,
            cableMm: +cable.toFixed(1),
            maxSegMm: +maxSeg.toFixed(2),
            spacingMm: +res.spacingMm.toFixed(2),
            wobbleMm: +res.wobbleMm.toFixed(2),
            crossings: res.crossings || 0,
            tipsLeftEmpty: res.tipsLeftEmpty || 0
        });
    }

    const out = {
        ok: variants.length > 0,
        jobId: input.jobId,
        docName: input.docName,
        params: P,
        boundsPt: { minX: bounds.minX * MM2PT, minY: bounds.minY * MM2PT, maxX: bounds.maxX * MM2PT, maxY: bounds.maxY * MM2PT },
        outlinePt: ringsMm.map(r => r.map(p => [+(p[0] * MM2PT).toFixed(2), +(p[1] * MM2PT).toFixed(2)])),
        variants,
        failedSeeds: failures.map(f => f.seed),
        seconds: +((Date.now() - t0) / 1000).toFixed(1)
    };
    if (!out.ok) {
        const pick = failures.find(f => f.report.needMoreDistance) || failures.find(f => f.report.maxPossibleCount < f.report.requestedCount) || failures[0];
        out.message = failureMessage(pick.report, P);
    }
    writeJSON(OUT_FILE, out);

    console.log('');
    if (out.ok) {
        console.log('  DONE in ' + out.seconds + ' s. ' + variants.length + ' of ' + P.variants + ' variants succeeded.');
        console.log('  Go back to Illustrator and run LED_Import.jsx');
    } else {
        console.log('  NO VALID LAYOUT. Run LED_Import.jsx to see why, or read below:');
        console.log('');
        console.log(out.message.split('\n').map(l => '  ' + l).join('\n'));
    }
    console.log('');
}

if (require.main === module) {
    try { main(); }
    catch (e) {
        console.error('Engine crashed: ' + (e.stack || e));
        writeFailure('The Node engine crashed:\n' + e.message);
    }
}
module.exports = { insetRings, Region, flattenRing, relaxEven, RNG, CableRules, findCrossings };
