'use strict';
/* Motor de visão: detecta a carta no quadro, reconhece qual é (entre as 52)
   e separa a assinatura. Tudo roda no próprio iPhone, sem internet. */
const Engine = (() => {

  function lumOf(d, n) {
    const L = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2];
    return L;
  }

  function otsu(L) {
    const hist = new Float64Array(256);
    for (let i = 0; i < L.length; i++) hist[L[i] | 0]++;
    const total = L.length; let sum = 0;
    for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, max = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > max) { max = v; thr = t; }
    }
    return thr;
  }

  function convexHull(pts) {
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lower = [];
    for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function orderQuad(c) {
    const cx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4, cy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
    c.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    const e02 = dist(c[0], c[1]) + dist(c[2], c[3]), e13 = dist(c[1], c[2]) + dist(c[3], c[0]);
    if (e02 > e13) c.push(c.shift()); // lado 0→1 = lado curto (topo)
    return c;
  }

  function fitLine(pts) {
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; }
    mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { px: mx, py: my, dx: Math.cos(a), dy: Math.sin(a) };
  }

  function intersect(l1, l2) {
    const det = -l1.dx * l2.dy + l2.dx * l1.dy;
    if (Math.abs(det) < 1e-6) return null;
    const t = ((l2.px - l1.px) * (-l2.dy) + l2.dx * (l2.py - l1.py)) / det;
    return { x: l1.px + t * l1.dx, y: l1.py + t * l1.dy };
  }

  function quadArea(q) {
    let a = 0; for (let i = 0; i < 4; i++) { const p = q[i], r = q[(i + 1) % 4]; a += p.x * r.y - r.x * p.y; }
    return Math.abs(a) / 2;
  }

  function isConvex(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
      const cr = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const s = Math.sign(cr); if (!s) return false;
      if (!sign) sign = s; else if (s !== sign) return false;
    }
    return true;
  }

  // Junta as arestas do contorno convexo em "trechos retos"; os 4 maiores são os lados da carta.
  function quadFromHull(hull, pts) {
    const m = hull.length, edges = [];
    let per = 0;
    for (let i = 0; i < m; i++) {
      const a = hull[i], b = hull[(i + 1) % m];
      const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
      per += l; edges.push({ i, a, b, l, ang: Math.atan2(dy, dx) });
    }
    const angDiff = (p, q) => { let d = Math.abs(p - q) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d; };
    // começa num ponto de mudança forte de direção
    let s0 = 0, big = -1;
    for (let i = 0; i < m; i++) { const d = angDiff(edges[i].ang, edges[(i + m - 1) % m].ang); if (d > big) { big = d; s0 = i; } }
    const chains = [];
    let cur = null;
    for (let k = 0; k < m; k++) {
      const e = edges[(s0 + k) % m];
      if (cur && angDiff(e.ang, cur.ang) < 0.17) {
        cur.l += e.l; cur.vx += e.b[0] - e.a[0]; cur.vy += e.b[1] - e.a[1]; cur.b = e.b; cur.ang = Math.atan2(cur.vy, cur.vx);
      } else {
        cur = { order: k, a: e.a, b: e.b, l: e.l, vx: e.b[0] - e.a[0], vy: e.b[1] - e.a[1], ang: e.ang };
        chains.push(cur);
      }
    }
    if (chains.length < 4) return null;
    const top4 = chains.slice().sort((p, q) => q.l - p.l).slice(0, 4);
    if (top4[3].l < per * 0.06) return null;
    top4.sort((p, q) => p.order - q.order);
    const diag = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0])) + Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]));
    const tol = Math.max(1.5, diag * 0.008);
    const lines = top4.map(ch => {
      const L = Math.hypot(ch.vx, ch.vy), ux = ch.vx / L, uy = ch.vy / L;
      const sel = [];
      for (const p of pts) {
        const px = p[0] - ch.a[0], py = p[1] - ch.a[1];
        const t = px * ux + py * uy;
        if (t < -L * 0.1 || t > L * 1.1) continue;
        if (Math.abs(-px * uy + py * ux) < tol) sel.push(p);
      }
      return sel.length >= 6 ? fitLine(sel) : { px: ch.a[0], py: ch.a[1], dx: ux, dy: uy };
    });
    const c = [];
    for (let k = 0; k < 4; k++) { const p = intersect(lines[(k + 3) % 4], lines[k]); if (!p) return null; c.push(p); }
    return orderQuad(c);
  }

  function quadFromExtremes(hull, pts) {
    let cx = 0, cy = 0; for (const p of hull) { cx += p[0]; cy += p[1]; } cx /= hull.length; cy /= hull.length;
    let p1 = hull[0], best = -1;
    for (const p of hull) { const d = (p[0] - cx) ** 2 + (p[1] - cy) ** 2; if (d > best) { best = d; p1 = p; } }
    let p3 = hull[0]; best = -1;
    for (const p of hull) { const d = (p[0] - p1[0]) ** 2 + (p[1] - p1[1]) ** 2; if (d > best) { best = d; p3 = p; } }
    const lx = p3[0] - p1[0], ly = p3[1] - p1[1];
    let p2 = null, p4 = null, mx = 0, mn = 0;
    for (const p of hull) { const s = lx * (p[1] - p1[1]) - ly * (p[0] - p1[0]); if (s > mx) { mx = s; p2 = p; } if (s < mn) { mn = s; p4 = p; } }
    if (!p2 || !p4) return null;
    return orderQuad([p1, p2, p3, p4].map(p => ({ x: p[0], y: p[1] })));
  }

  function quadFromComponent(lab, id, w, h, on) {
    // preenche os "buracos" (naipes, figuras) para ficar só o contorno externo da carta
    const n = w * h, outside = new Uint8Array(n), stack = new Int32Array(n); let sp = 0;
    const push = q => { if (!outside[q] && lab[q] !== id) { outside[q] = 1; stack[sp++] = q; } };
    for (let x = 0; x < w; x++) { push(x); push(n - w + x); }
    for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
    while (sp) {
      const p = stack[--sp], x = p % w;
      if (x > 0) push(p - 1); if (x < w - 1) push(p + 1); if (p >= w) push(p - w); if (p < n - w) push(p + w);
    }
    const pts = []; let border = 0, area = 0;
    for (let i = 0; i < n; i++) {
      if (outside[i]) continue;
      area++;
      const x = i % w, y = (i / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { border++; pts.push([x, y]); continue; }
      if (outside[i - 1] || outside[i + 1] || outside[i - w] || outside[i + w]) pts.push([x, y]);
    }
    if (pts.length < 40 || border > pts.length * 0.04) return null;
    const hull = convexHull(pts.slice());
    if (hull.length < 4) return null;
    let c = quadFromHull(hull, pts) || quadFromExtremes(hull, pts);
    if (!c) return null;
    if (!isConvex(c)) return null;
    const s01 = dist(c[0], c[1]), s23 = dist(c[2], c[3]), s12 = dist(c[1], c[2]), s30 = dist(c[3], c[0]);
    if (Math.min(s01, s23) / Math.max(s01, s23) < 0.75 || Math.min(s12, s30) / Math.max(s12, s30) < 0.75) return null;
    const short = (s01 + s23) / 2, long = (s12 + s30) / 2;
    const ratio = short / long;
    if (ratio < 0.5 || ratio > 0.92) return null;
    const qa = quadArea(c), fill = area / qa;
    if (fill > 1.12) return null;
    // a margem branca da carta tem que estar logo dentro de cada lado, e fora tem que ser escuro
    const gx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4, gy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
    let inTot = 0, outTot = 0, N = 0, minSide = 1;
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      const ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey);
      let nx = -ey / el, ny = ex / el;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (nx * (gx - mx) + ny * (gy - my) < 0) { nx = -nx; ny = -ny; }
      const off = Math.max(1.5, short * 0.035);
      let sin = 0, sout = 0, cnt = 0;
      for (let j = 0; j < 30; j++) {
        const t = 0.1 + 0.8 * j / 29, px = a.x + ex * t, py = a.y + ey * t;
        const ix = Math.round(px + nx * off), iy = Math.round(py + ny * off);
        const ox = Math.round(px - nx * off * 1.5), oy = Math.round(py - ny * off * 1.5);
        cnt++;
        if (ix >= 0 && iy >= 0 && ix < w && iy < h && on[iy * w + ix]) sin++;
        if (!(ox >= 0 && oy >= 0 && ox < w && oy < h) || !on[oy * w + ox]) sout++;
      }
      inTot += sin; outTot += sout; N += cnt; minSide = Math.min(minSide, sin / cnt);
    }
    if (inTot / N < 0.72 || minSide < 0.4 || outTot / N < 0.7) return null;
    return { quad: c, area: qa, fill, ratio, edge: inTot / N };
  }

  /** Procura a carta (retângulo claro) num quadro pequeno (ImageData). */
  function detectCard(img) {
    const w = img.width, h = img.height, n = w * h;
    const d = img.data, L = lumOf(d, n);
    const thr = Math.max(otsu(L), 28);
    // cor do papel = média dos 2% de pixels mais claros; pele e fundo colorido ficam de fora
    const hist = new Uint32Array(256); for (let i = 0; i < n; i++) hist[L[i] | 0]++;
    let acc = 0, top = 255; while (top > 0 && acc + hist[top] < n * 0.02) { acc += hist[top]; top--; }
    let pr = 0, pb = 0, pk = 0;
    for (let i = 0; i < n; i++) if (L[i] >= top) { const l = L[i] || 1; pr += d[i * 4] / l; pb += d[i * 4 + 2] / l; pk++; }
    pr /= pk || 1; pb /= pk || 1;
    const on = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (L[i] <= thr) continue;
      const l = L[i];
      if (Math.abs(d[i * 4] / l - pr) + Math.abs(d[i * 4 + 2] / l - pb) < 0.22) on[i] = 1;
    }
    // abertura 3×3: corta pontes finas (dedo encostado na borda, ruído)
    const er = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (on[i] && on[i - 1] && on[i + 1] && on[i - w] && on[i + w] && on[i - w - 1] && on[i - w + 1] && on[i + w - 1] && on[i + w + 1]) er[i] = 1;
    }
    on.fill(0);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (er[i] || er[i - 1] || er[i + 1] || er[i - w] || er[i + w] || er[i - w - 1] || er[i - w + 1] || er[i + w - 1] || er[i + w + 1]) on[i] = 1;
    }
    const lab = new Int32Array(n), stack = new Int32Array(n);
    const comps = []; let cur = 0;
    for (let i = 0; i < n; i++) {
      if (lab[i] || !on[i]) continue;
      cur++; let sp = 0; stack[sp++] = i; lab[i] = cur; let area = 0;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w;
        if (x > 0) { const q = p - 1; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
        if (x < w - 1) { const q = p + 1; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
        if (p >= w) { const q = p - w; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
        if (p < n - w) { const q = p + w; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
      }
      if (area > n * 0.006) comps.push({ id: cur, area });
    }
    comps.sort((a, b) => b.area - a.area);
    for (let k = 0; k < Math.min(3, comps.length); k++) {
      const r = quadFromComponent(lab, comps[k].id, w, h, on);
      if (r) return r;
    }
    return null;
  }

  function solve(A, B) {
    const n = B.length;
    for (let i = 0; i < n; i++) A[i].push(B[i]);
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      const v = A[c][c]; if (Math.abs(v) < 1e-12) return null;
      for (let j = c; j <= n; j++) A[c][j] /= v;
      for (let r = 0; r < n; r++) if (r !== c) { const f = A[r][c]; if (f) for (let j = c; j <= n; j++) A[r][j] -= f * A[c][j]; }
    }
    return A.map(row => row[n]);
  }

  function homography(src, dst) {
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = src[i], u = dst[i].x, v = dst[i].y;
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    const h = solve(A, B); if (!h) return null;
    h.push(1); return h;
  }

  /** Recorta a carta (quad TL,TR,BR,BL) e endireita em W×H. Saída RGB float intercalado. */
  function warp(img, quad, W, H) {
    const m = homography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], quad);
    const out = new Float32Array(W * H * 3);
    if (!m) return out;
    const d = img.data, iw = img.width, ih = img.height;
    let o = 0;
    for (let v = 0; v < H; v++) {
      const vv = v + 0.5;
      for (let u = 0; u < W; u++) {
        const uu = u + 0.5;
        const z = m[6] * uu + m[7] * vv + 1;
        let x = (m[0] * uu + m[1] * vv + m[2]) / z - 0.5, y = (m[3] * uu + m[4] * vv + m[5]) / z - 0.5;
        if (x < 0) x = 0; else if (x > iw - 1.001) x = iw - 1.001;
        if (y < 0) y = 0; else if (y > ih - 1.001) y = ih - 1.001;
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = (y0 * iw + x0) * 4, i10 = i00 + 4, i01 = i00 + iw * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o++] = d[i00] * w00 + d[i10] * w10 + d[i01] * w01 + d[i11] * w11;
        out[o++] = d[i00 + 1] * w00 + d[i10 + 1] * w10 + d[i01 + 1] * w01 + d[i11 + 1] * w11;
        out[o++] = d[i00 + 2] * w00 + d[i10 + 2] * w10 + d[i01 + 2] * w01 + d[i11 + 2] * w11;
      }
    }
    return out;
  }

  /** Vetor de comparação: RGB com balanço de branco, desfocado, normalizado. */
  function features(rgb, w, h) {
    const n = w * h, out = new Float32Array(n * 3);
    for (let c = 0; c < 3; c++) {
      const ch = new Float32Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0, k = 0;
        for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += rgb[(yy * w + xx) * 3 + c]; k++; } }
        ch[y * w + x] = s / k;
      }
      const sorted = Array.from(ch).sort((a, b) => a - b);
      const white = Math.max(sorted[Math.floor(n * 0.97)], 1);
      for (let i = 0; i < n; i++) out[c * n + i] = Math.min(ch[i] / white, 1.1);
    }
    let mean = 0; for (let i = 0; i < out.length; i++) mean += out[i]; mean /= out.length;
    let sd = 0; for (let i = 0; i < out.length; i++) { out[i] -= mean; sd += out[i] * out[i]; }
    sd = Math.sqrt(sd / out.length) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
  }

  /** Compara com as 52 cartas, nas duas orientações (0° e 180°). */
  function match(f, templates) {
    const N = f.length, P = N / 3, res = [];
    for (const t of templates) {
      const g = t.feat; let s0 = 0, s1 = 0;
      for (let c = 0; c < 3; c++) {
        const b = c * P;
        for (let p = 0; p < P; p++) { const gv = g[b + p]; s0 += f[b + p] * gv; s1 += f[b + P - 1 - p] * gv; }
      }
      s0 /= N; s1 /= N;
      res.push({ id: t.id, score: Math.max(s0, s1), rot: s1 > s0 });
    }
    res.sort((a, b) => b.score - a.score);
    return { best: res[0], second: res[1], all: res };
  }

  function sharpness(rgb, w, h) {
    let s = 0, s2 = 0, k = 0;
    const lum = i => 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    for (let y = 2; y < h - 2; y += 2) for (let x = 2; x < w - 2; x += 2) {
      const i = y * w + x;
      const l = 4 * lum(i) - lum(i - 1) - lum(i + 1) - lum(i - w) - lum(i + w);
      s += l; s2 += l * l; k++;
    }
    const m = s / k; return s2 / k - m * m;
  }

  // As imagens das cartas têm uma borda suave de ~5 px; a borda real da carta fica um pouco para dentro.
  const INSET = 5.3 / 537;
  function cardRect(src) {
    const iw = src.naturalWidth || src.width, ih = src.naturalHeight || src.height;
    const m = iw * INSET;
    return { x: m, y: m, w: iw - 2 * m, h: ih - 2 * m, iw, ih };
  }
  function imageToRGB(src, W, H, bg) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = bg || '#000'; x.fillRect(0, 0, W, H);
    const r = cardRect(src);
    x.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, W, H);
    const d = x.getImageData(0, 0, W, H).data, out = new Float32Array(W * H * 3);
    for (let i = 0, j = 0; i < W * H; i++, j += 4) { out[i * 3] = d[j]; out[i * 3 + 1] = d[j + 1]; out[i * 3 + 2] = d[j + 2]; }
    return out;
  }

  function templateFeatures(src, W, H) { return features(imageToRGB(src, W, H, '#000'), W, H); }

  // ---------- Assinatura ----------
  function integral(a, w, h) {
    const W1 = w + 1, I = new Float64Array(W1 * (h + 1));
    for (let y = 0; y < h; y++) { let row = 0; for (let x = 0; x < w; x++) { row += a[y * w + x]; I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + row; } }
    return I;
  }
  function boxSum(I, w, h, r) {
    const W1 = w + 1, out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
        out[y * w + x] = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
      }
    }
    return out;
  }

  function minFilter(a, w, h, r) {
    const t = new Float32Array(w * h), o = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 1e9; const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      for (let k = x0; k <= x1; k++) { const v = a[y * w + k]; if (v < m) m = v; }
      t[y * w + x] = m;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let m = 1e9; const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
      for (let k = y0; k <= y1; k++) { const v = t[k * w + x]; if (v < m) m = v; }
      o[y * w + x] = m;
    }
    return o;
  }

  /** Ajuste fino: corrige pequenas diferenças locais (carta levemente curvada, lente) entre a foto e a carta guardada. */
  function alignToTemplate(cap, tpl, W, H) {
    const hw = W >> 1, hh = H >> 1;
    const cl = new Float32Array(hw * hh), tl = new Float32Array(hw * hh);
    for (let y = 0; y < hh; y++) for (let x = 0; x < hw; x++) {
      let a = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const i = ((2 * y + dy) * W + 2 * x + dx) * 3;
        a += 0.299 * cap[i] + 0.587 * cap[i + 1] + 0.114 * cap[i + 2];
        b += 0.299 * tpl[i] + 0.587 * tpl[i + 1] + 0.114 * tpl[i + 2];
      }
      cl[y * hw + x] = a / 4; tl[y * hw + x] = b / 4;
    }
    const GX = 6, GY = 8, B = 18, R = 6, M = B + R + 2;
    const cx = k => M + (hw - 2 * M) * k / (GX - 1), cy = k => M + (hh - 2 * M) * k / (GY - 1);
    const DX = new Float32Array(GX * GY), DY = new Float32Array(GX * GY), V = new Uint8Array(GX * GY);
    for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
      const x0 = Math.round(cx(gx)), y0 = Math.round(cy(gy));
      let tm = 0, tn = 0;
      for (let y = -B; y <= B; y++) for (let x = -B; x <= B; x++) { tm += tl[(y0 + y) * hw + x0 + x]; tn++; }
      tm /= tn;
      let tv = 0;
      for (let y = -B; y <= B; y++) for (let x = -B; x <= B; x++) { const v = tl[(y0 + y) * hw + x0 + x] - tm; tv += v * v; }
      if (Math.sqrt(tv / tn) < 14) continue;
      let best = -2, bx = 0, by = 0;
      for (let sy = -R; sy <= R; sy++) for (let sx = -R; sx <= R; sx++) {
        let cm = 0;
        for (let y = -B; y <= B; y += 2) for (let x = -B; x <= B; x += 2) cm += cl[(y0 + y + sy) * hw + x0 + x + sx];
        cm /= ((B + 1) * (B + 1));
        let num = 0, den = 0, dt = 0;
        for (let y = -B; y <= B; y += 2) for (let x = -B; x <= B; x += 2) {
          const c = cl[(y0 + y + sy) * hw + x0 + x + sx] - cm, t = tl[(y0 + y) * hw + x0 + x] - tm;
          num += c * t; den += c * c; dt += t * t;
        }
        const ncc = num / Math.sqrt(den * dt + 1e-6);
        if (ncc > best) { best = ncc; bx = sx; by = sy; }
      }
      if (best > 0.5 && Math.abs(bx) < R && Math.abs(by) < R) { const k = gy * GX + gx; DX[k] = bx; DY[k] = by; V[k] = 1; }
    }
    let nv = 0; for (let k = 0; k < V.length; k++) nv += V[k];
    if (nv < 4) return cap;
    // mediana 3×3 nos válidos (tira erros isolados) e preenche os vazios com os vizinhos
    const med = (arr) => { const a = arr.slice().sort((p, q) => p - q); return a[a.length >> 1]; };
    const mx = new Float32Array(GX * GY), my = new Float32Array(GX * GY);
    for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
      const ax = [], ay = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = gx + dx, yy = gy + dy; if (xx < 0 || yy < 0 || xx >= GX || yy >= GY) continue;
        const k = yy * GX + xx; if (V[k]) { ax.push(DX[k]); ay.push(DY[k]); }
      }
      const k = gy * GX + gx;
      if (ax.length) { mx[k] = med(ax); my[k] = med(ay); }
    }
    const allx = [], ally = []; for (let k = 0; k < V.length; k++) if (V[k]) { allx.push(DX[k]); ally.push(DY[k]); }
    const gmx = med(allx), gmy = med(ally);
    const has = new Uint8Array(GX * GY);
    for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
      let any = false; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = gx + dx, yy = gy + dy; if (xx >= 0 && yy >= 0 && xx < GX && yy < GY && V[yy * GX + xx]) any = true; }
      const k = gy * GX + gx; if (any) has[k] = 1; else { mx[k] = gmx; my[k] = gmy; }
    }
    // remapeia em resolução cheia
    const out = new Float32Array(W * H * 3);
    const stepX = (hw - 2 * M) / (GX - 1), stepY = (hh - 2 * M) / (GY - 1);
    for (let y = 0; y < H; y++) {
      let gyf = (y / 2 - M) / stepY; if (gyf < 0) gyf = 0; if (gyf > GY - 1) gyf = GY - 1;
      const gy0 = Math.min(GY - 2, gyf | 0), fy = gyf - gy0;
      for (let x = 0; x < W; x++) {
        let gxf = (x / 2 - M) / stepX; if (gxf < 0) gxf = 0; if (gxf > GX - 1) gxf = GX - 1;
        const gx0 = Math.min(GX - 2, gxf | 0), fx = gxf - gx0;
        const k = gy0 * GX + gx0;
        const ddx = (mx[k] * (1 - fx) + mx[k + 1] * fx) * (1 - fy) + (mx[k + GX] * (1 - fx) + mx[k + GX + 1] * fx) * fy;
        const ddy = (my[k] * (1 - fx) + my[k + 1] * fx) * (1 - fy) + (my[k + GX] * (1 - fx) + my[k + GX + 1] * fx) * fy;
        let sx = x + 2 * ddx, sy = y + 2 * ddy;
        if (sx < 0) sx = 0; if (sx > W - 1.001) sx = W - 1.001; if (sy < 0) sy = 0; if (sy > H - 1.001) sy = H - 1.001;
        const x0 = sx | 0, y0 = sy | 0, ax = sx - x0, ay = sy - y0;
        const i00 = (y0 * W + x0) * 3, i10 = i00 + 3, i01 = i00 + W * 3, i11 = i01 + 3, o = (y * W + x) * 3;
        for (let c = 0; c < 3; c++) out[o + c] = (cap[i00 + c] * (1 - ax) + cap[i10 + c] * ax) * (1 - ay) + (cap[i01 + c] * (1 - ax) + cap[i11 + c] * ax) * ay;
      }
    }
    return out;
  }

  /** cap e tpl: RGB float W×H já alinhados. Devolve alfa (0..255) da tinta e a cor da tinta. */
  function extractSignature(cap, tpl, W, H, opts) {
    opts = opts || {};
    cap = alignToTemplate(cap, tpl, W, H);
    const n = W * H;
    const tl = new Float32Array(n);
    for (let i = 0; i < n; i++) tl[i] = 0.299 * tpl[i * 3] + 0.587 * tpl[i * 3 + 1] + 0.114 * tpl[i * 3 + 2];
    // menor brilho da carta num raio de 4 px: tolera pequeno desalinhamento entre foto e carta guardada
    const tmin = minFilter(tl, W, H, opts.court ? 2 : 3);
    // bordas do desenho da carta (onde um pequeno desalinhamento geraria "falsa tinta")
    const tb = boxSum(integral(tl, W, H), W, H, 1);
    const edge = new Float32Array(n);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = (tb[i - W + 1] + 2 * tb[i + 1] + tb[i + W + 1]) - (tb[i - W - 1] + 2 * tb[i - 1] + tb[i + W - 1]);
      const gy = (tb[i + W - 1] + 2 * tb[i + W] + tb[i + W + 1]) - (tb[i - W - 1] + 2 * tb[i - W] + tb[i - W + 1]);
      if (Math.abs(gx) + Math.abs(gy) > 9 * 70) edge[i] = 1;
    }
    const edgeD = boxSum(integral(edge, W, H), W, H, 3);
    // ganho local do papel por canal (compensa luz fraca, sombra e cor da luz)
    const R = 26;
    let S = new Float32Array(n);
    const gains = [null, null, null];
    for (let pass = 0; pass < 2; pass++) {
      const paper = new Float32Array(n);
      for (let i = 0; i < n; i++) if (edgeD[i] === 0 && tl[i] > 170 && S[i] < 0.15) paper[i] = 1;
      const pc = boxSum(integral(paper, W, H), W, H, R);
      let totP = 0; for (let i = 0; i < n; i++) totP += paper[i];
      for (let c = 0; c < 3; c++) {
        const a = new Float32Array(n), b = new Float32Array(n);
        let ga = 0, gb = 0;
        for (let i = 0; i < n; i++) if (paper[i]) { a[i] = cap[i * 3 + c]; b[i] = tpl[i * 3 + c]; ga += a[i]; gb += b[i]; }
        const gGlobal = totP > 0 ? ga / Math.max(gb, 1) : 1;
        const sa = boxSum(integral(a, W, H), W, H, R), sb = boxSum(integral(b, W, H), W, H, R);
        const g = new Float32Array(n);
        for (let i = 0; i < n; i++) g[i] = pc[i] > 40 ? sa[i] / Math.max(sb[i], 1) : gGlobal;
        gains[c] = g;
      }
      S = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const e = tmin[i];
        if (e < 45) continue; // embaixo de partes escuras do desenho não dá para ver tinta
        const r = cap[i * 3] / Math.max(gains[0][i], 0.02), g = cap[i * 3 + 1] / Math.max(gains[1][i], 0.02), b = cap[i * 3 + 2] / Math.max(gains[2][i], 0.02);
        const nl = 0.299 * r + 0.587 * g + 0.114 * b, ratio = nl / e;
        const rr = r / (tpl[i * 3] + 1), rg = g / (tpl[i * 3 + 1] + 1), rb = b / (tpl[i * 3 + 2] + 1);
        if (tl[i] > 150 && rr - rb > 0.2 && rg > 0.33 && rr > 0.5) continue; // pele (dedos)
        const sv = (0.72 - ratio) / 0.3;
        S[i] = sv < 0 ? 0 : sv > 1 ? 1 : sv;
      }
    }
    // componentes conectados do traço
    const core = new Uint8Array(n); for (let i = 0; i < n; i++) if (S[i] > 0.3) core[i] = 1;
    const lab = new Int32Array(n), stack = new Int32Array(n), keep = new Uint8Array(n);
    const band = Math.round(W * 0.03);
    let cur = 0;
    for (let i = 0; i < n; i++) {
      if (!core[i] || lab[i]) continue;
      cur++; let sp = 0; stack[sp++] = i; lab[i] = cur;
      const list = []; let minx = W, maxx = 0, miny = H, maxy = 0, touch = false;
      while (sp) {
        const p = stack[--sp]; list.push(p);
        const x = p % W, y = (p / W) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x < band || y < band || x >= W - band || y >= H - band) touch = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx; if (core[q] && !lab[q]) { lab[q] = cur; stack[sp++] = q; }
        }
      }
      const area = list.length, bbox = (maxx - minx + 1) * (maxy - miny + 1);
      if (area < 14) continue;
      if (touch) continue;
      if (area > n * 0.004 && area / bbox > 0.45) continue; // mancha (sombra/dedo), não traço
      for (const p of list) keep[p] = 1;
    }
    const kd = boxSum(integral(keep, W, H), W, H, 1);
    const alpha = new Uint8ClampedArray(n);
    let cr = 0, cg = 0, cb = 0, ck = 0, count = 0;
    for (let i = 0; i < n; i++) {
      if (kd[i] === 0) continue;
      const a = Math.min(1, S[i] * 1.2);
      if (a <= 0) continue;
      alpha[i] = Math.round(a * 255); count++;
      if (keep[i] && S[i] > 0.6 && tl[i] > 170) {
        cr += cap[i * 3] / Math.max(gains[0][i], 0.02); cg += cap[i * 3 + 1] / Math.max(gains[1][i], 0.02); cb += cap[i * 3 + 2] / Math.max(gains[2][i], 0.02); ck++;
      }
    }
    let color = [22, 22, 26];
    if (ck > 20) {
      const r = cr / ck, g = cg / ck, b = cb / ck;
      if (b > r * 1.25 && b > g * 1.05) color = [24, 38, 120];
    }
    return { alpha, color, count, W, H };
  }

  return { cardRect, detectCard, warp, features, match, sharpness, imageToRGB, templateFeatures, extractSignature, homography };
})();
if (typeof window !== 'undefined') window.Engine = Engine;

/* Recorta a carta do quadro em alta resolução e refaz a detecção dos cantos ali (bem mais precisa).
   q: quad (TL,TR,BR,BL na orientação já corrigida) em coordenadas do quadro grande. */
Engine.cropRefine = function (src, vw, vh, q, canvas, ctx) {
  const xs = q.map(p => p.x), ys = q.map(p => p.y);
  const mw = (Math.max(...xs) - Math.min(...xs)) * 0.1, mh = (Math.max(...ys) - Math.min(...ys)) * 0.1;
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - mw)), y0 = Math.max(0, Math.floor(Math.min(...ys) - mh));
  const x1 = Math.min(vw, Math.ceil(Math.max(...xs) + mw)), y1 = Math.min(vh, Math.ceil(Math.max(...ys) + mh));
  const bw = x1 - x0, bh = y1 - y0;
  if (bw < 20 || bh < 20) return null;
  canvas.width = bw; canvas.height = bh;
  ctx.drawImage(src, x0, y0, bw, bh, 0, 0, bw, bh);
  const im = ctx.getImageData(0, 0, bw, bh);
  const local = q.map(p => ({ x: p.x - x0, y: p.y - y0 }));
  let quad = local;
  const det = Engine.detectCard(im);
  if (det) {
    // casa os cantos novos com os antigos (mantém a orientação)
    const c = det.quad; let best = 0, bd = 1e18;
    for (let s = 0; s < 4; s++) { let dd = 0; for (let k = 0; k < 4; k++) { const a = c[(k + s) % 4], b = local[k]; dd += (a.x - b.x) ** 2 + (a.y - b.y) ** 2; } if (dd < bd) { bd = dd; best = s; } }
    const diag = Math.hypot(bw, bh);
    if (Math.sqrt(bd / 4) < diag * 0.06) quad = [0, 1, 2, 3].map(k => c[(k + best) % 4]);
  }
  return { im, quad };
};
