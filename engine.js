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
    const diag = Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0])) + Math.max(...pts.map(p => p[1])) - Math.min(...pts.map(p => p[1]));
    const tol = Math.max(1.5, diag * 0.01);
    // apoio de cada trecho = quantos pontos do contorno caem sobre a reta dele
    // (um lado de verdade tem muitos; o "atalho" do contorno por cima de um dedo tem poucos)
    // ajuste iterativo: tolerância larga → estreita, descartando os piores pontos
    const lineSel = (ln, ax, ay, L, ux, uy, tl_) => {
      const sel = [];
      for (const p of pts) {
        const px = p[0] - ax, py = p[1] - ay, t = px * ux + py * uy;
        if (t < -L * 0.6 || t > L * 1.6) continue;
        const dd = Math.abs(-(p[0] - ln.px) * ln.dy + (p[1] - ln.py) * ln.dx);
        if (dd < tl_) sel.push([p[0], p[1], dd]);
      }
      return sel;
    };
    for (const ch of chains) {
      const L = Math.hypot(ch.vx, ch.vy) || 1, ux = ch.vx / L, uy = ch.vy / L;
      let ln = { px: ch.a[0], py: ch.a[1], dx: ux, dy: uy };
      let sel = [];
      for (const k of [3.5, 2, 1.2]) {
        sel = lineSel(ln, ch.a[0], ch.a[1], L, ux, uy, tol * k);
        if (sel.length < 6) break;
        sel.sort((p, q) => p[2] - q[2]);
        const keep = sel.slice(0, Math.max(6, Math.ceil(sel.length * 0.75)));
        ln = fitLine(keep);
      }
      sel = lineSel(ln, ch.a[0], ch.a[1], L, ux, uy, tol * 1.2);
      ch.sel = sel; ch.support = sel.length; ch.line = ln;
    }
    // junta trechos sobre a mesma reta (lado interrompido por um dedo)
    const byS = chains.slice().sort((p, q) => q.support - p.support), picked = [];
    for (const ch of byS) {
      if (ch.support < 6) continue;
      const same = picked.find(o => {
        const cosA = Math.abs(o.line.dx * ch.line.dx + o.line.dy * ch.line.dy);
        const off = Math.abs(-(ch.line.px - o.line.px) * o.line.dy + (ch.line.py - o.line.py) * o.line.dx);
        return cosA > Math.cos(0.14) && off < tol * 3;
      });
      if (same) { same.sel = same.sel.concat(ch.sel); same.line = fitLine(same.sel); same.support += ch.support; continue; }
      picked.push(ch);
      if (picked.length >= 4) break;
    }
    if (picked.length < 4) return null;
    if (picked[3].support < per * 0.03) return null;
    picked.sort((p, q) => p.order - q.order);
    const lines = picked.map(ch => ch.line);
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

  function sampleL(L, w, h, x, y) {
    if (x < 0) x = 0; if (y < 0) y = 0; if (x > w - 1.001) x = w - 1.001; if (y > h - 1.001) y = h - 1.001;
    const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
    return (L[i] * (1 - fx) + L[i + 1] * fx) * (1 - fy) + (L[i + w] * (1 - fx) + L[i + w + 1] * fx) * fy;
  }
  /** Encosta cada lado na borda real (ponto de maior contraste perto da reta). */
  function snapQuad(c, L, w, h, rf) {
    const gx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4, gy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
    const short = Math.min(dist(c[0], c[1]), dist(c[1], c[2]));
    const R = Math.max(3, short * (rf || 0.06));
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      const ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey);
      let nx = -ey / el, ny = ex / el;
      if (nx * (gx - (a.x + b.x) / 2) + ny * (gy - (a.y + b.y) / 2) < 0) { nx = -nx; ny = -ny; }
      const pts = [];
      for (let j = 0; j < 28; j++) {
        const t = 0.12 + 0.76 * j / 27, px = a.x + ex * t, py = a.y + ey * t;
        let best = -1, bo = 0;
        for (let o = -R; o <= R; o += 0.5) {
          const qx = px + nx * o, qy = py + ny * o;
          const g = Math.abs(sampleL(L, w, h, qx + nx, qy + ny) - sampleL(L, w, h, qx - nx, qy - ny));
          if (g > best) { best = g; bo = o; }
        }
        if (best > 8) pts.push([px + nx * bo, py + ny * bo]);
      }
      if (pts.length < 8) { lines.push({ px: a.x, py: a.y, dx: ex / el, dy: ey / el }); continue; }
      let ln = fitLine(pts);
      const res = pts.map(p => [p, Math.abs(-(p[0] - ln.px) * ln.dy + (p[1] - ln.py) * ln.dx)]).sort((p, q) => p[1] - q[1]);
      ln = fitLine(res.slice(0, Math.ceil(res.length * 0.7)).map(r => r[0]));
      lines.push(ln);
    }
    const out = [];
    for (let k = 0; k < 4; k++) { const p = intersect(lines[(k + 3) % 4], lines[k]); if (!p || dist(p, c[k]) > short * 0.15) return null; out.push(p); }
    return out;
  }

  function quadFromComponent(lab, id, w, h, on, L) {
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
      if (x <= 2 || y <= 2 || x >= w - 3 || y >= h - 3) border++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { pts.push([x, y]); continue; }
      if (outside[i - 1] || outside[i + 1] || outside[i - w] || outside[i + w]) pts.push([x, y]);
    }
    if (pts.length < 40 || border > pts.length * 0.04) return null;
    const hull = convexHull(pts.slice());
    if (hull.length < 4) return null;
    let c = quadFromHull(hull, pts) || quadFromExtremes(hull, pts);
    if (!c) return null;
    if (L) { const sn = snapQuad(c, L, w, h); if (sn) c = sn; }
    if (!isConvex(c)) return null;

    const s01 = dist(c[0], c[1]), s23 = dist(c[2], c[3]), s12 = dist(c[1], c[2]), s30 = dist(c[3], c[0]);
    if (Math.min(s01, s23) / Math.max(s01, s23) < 0.75 || Math.min(s12, s30) / Math.max(s12, s30) < 0.75) return null;
    const short = (s01 + s23) / 2, long = (s12 + s30) / 2;
    const ratio = short / long;
    if (ratio < 0.5 || ratio > 0.92) return null;
    const qa = quadArea(c), fill = area / qa;
    if (fill > 1.12) return null;
    // a margem da carta tem que estar logo dentro de cada lado, e a borda tem que ter contraste com o fundo
    const gx = (c[0].x + c[1].x + c[2].x + c[3].x) / 4, gy = (c[0].y + c[1].y + c[2].y + c[3].y) / 4;
    let inTot = 0, N = 0, minSide = 1, minCon = 1e9, outTot = 0;
    for (let k = 0; k < 4; k++) {
      const a = c[k], b = c[(k + 1) % 4];
      const ex = b.x - a.x, ey = b.y - a.y, el = Math.hypot(ex, ey);
      let nx = -ey / el, ny = ex / el;
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (nx * (gx - mx) + ny * (gy - my) < 0) { nx = -nx; ny = -ny; }
      const off = Math.max(1.5, short * 0.035);
      let sin = 0, cnt = 0, li = 0, lo = 0, sout = 0;
      for (let j = 0; j < 30; j++) {
        const t = 0.1 + 0.8 * j / 29, px = a.x + ex * t, py = a.y + ey * t;
        const ix = Math.round(px + nx * off), iy = Math.round(py + ny * off);
        const ox = Math.min(w - 1, Math.max(0, Math.round(px - nx * off * 1.5))), oy = Math.min(h - 1, Math.max(0, Math.round(py - ny * off * 1.5)));
        cnt++;
        if (ix >= 0 && iy >= 0 && ix < w && iy < h) { if (on[iy * w + ix]) sin++; if (L) li += L[iy * w + ix]; }
        if (!on[oy * w + ox]) sout++;
        if (L) lo += L[oy * w + ox];
      }
      inTot += sin; outTot += sout; N += cnt; minSide = Math.min(minSide, sin / cnt);
      if (L) minCon = Math.min(minCon, Math.abs(li - lo) / cnt);
    }
    if (inTot / N < 0.72 || minSide < 0.4) return null;
    if (L ? minCon < 7 : outTot / N < 0.7) return null;
    return { quad: c, area: qa, fill, ratio, edge: (inTot + outTot) / (2 * N) };
  }

  function erode(on, w, h) {
    const n = w * h, out = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (on[i] && on[i - 1] && on[i + 1] && on[i - w] && on[i + w]) out[i] = 1;
    }
    return out;
  }
  function dilate(on, w, h) {
    const n = w * h, out = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (on[i] || on[i - 1] || on[i + 1] || on[i - w] || on[i + w]) out[i] = 1;
    }
    return out;
  }

  function openMask(on, w, h) {
    const n = w * h, er = new Uint8Array(n), out = new Uint8Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (on[i] && on[i - 1] && on[i + 1] && on[i - w] && on[i + w] && on[i - w - 1] && on[i - w + 1] && on[i + w - 1] && on[i + w + 1]) er[i] = 1;
    }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (er[i] || er[i - 1] || er[i + 1] || er[i - w] || er[i + w] || er[i - w - 1] || er[i - w + 1] || er[i + w - 1] || er[i + w + 1]) out[i] = 1;
    }
    return out;
  }

  function labelMask(on, w, h, minArea) {
    const n = w * h, lab = new Int32Array(n), stack = new Int32Array(n), comps = [];
    let cur = 0;
    for (let i = 0; i < n; i++) {
      if (lab[i] || !on[i]) continue;
      cur++; let sp = 0; stack[sp++] = i; lab[i] = cur; let area = 0;
      let x0 = w, x1 = 0, y0 = h, y1 = 0;
      while (sp) {
        const p = stack[--sp]; area++;
        const x = p % w, y = (p / w) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x > 0) { const q = p - 1; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
        if (x < w - 1) { const q = p + 1; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
        if (p >= w) { const q = p - w; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
        if (p < n - w) { const q = p + w; if (!lab[q] && on[q]) { lab[q] = cur; stack[sp++] = q; } }
      }
      if (area > minArea) comps.push({ id: cur, area, x0, x1, y0, y1 });
    }
    comps.sort((a, b) => b.area - a.area);
    return { lab, comps };
  }

  /**
   * Procura cartas (retângulos claros) num quadro pequeno. Tenta vários níveis de brilho,
   * porque atrás da carta pode haver coisas mais claras que ela (luzes do teto, câmera da frente).
   * Devolve os candidatos, do mais provável para o menos.
   */
  function detectCards(img) {
    const w = img.width, h = img.height, n = w * h;
    const d = img.data, L = lumOf(d, n);
    // cor média num raio de 2 px (o ruído de cor da câmera no escuro é grande pixel a pixel)
    const Rc = new Float32Array(n), Gc = new Float32Array(n), Bc = new Float32Array(n);
    for (let i = 0; i < n; i++) { Rc[i] = d[i * 4]; Gc[i] = d[i * 4 + 1]; Bc[i] = d[i * 4 + 2]; }
    const sR = boxSum(integral(Rc, w, h), w, h, 2), sG = boxSum(integral(Gc, w, h), w, h, 2), sB = boxSum(integral(Bc, w, h), w, h, 2);
    const cR = new Float32Array(n), cB = new Float32Array(n);
    for (let i = 0; i < n; i++) { const l = 0.299 * sR[i] + 0.587 * sG[i] + 0.114 * sB[i] || 1; cR[i] = sR[i] / l; cB[i] = sB[i] / l; }
    const hist = new Uint32Array(256); for (let i = 0; i < n; i++) hist[L[i] | 0]++;
    const quant = q => { let acc = 0; for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= n * q) return t; } return 255; };
    const thrs = [];
    for (const t of [otsu(L), quant(0.6), quant(0.8)]) {
      const v = Math.max(t, 28);
      if (v < 250 && !thrs.some(u => Math.abs(u - v) < 8)) thrs.push(v);
    }
    const cands = [];
    const tries = [];
    for (const t of thrs) tries.push([t, 1]);
    // carta mais escura que o fundo (teto claro, luzes atrás dela)
    for (const t of [quant(0.4), quant(0.6)]) if (t > 40 && t < 250) tries.push([t, -1]);
    for (const [thr, pol] of tries) {
      const m0 = new Uint8Array(n);
      if (pol > 0) { for (let i = 0; i < n; i++) if (L[i] > thr) m0[i] = 1; }
      else { for (let i = 0; i < n; i++) if (L[i] < thr && L[i] > 25) m0[i] = 1; }
      const { lab, comps } = labelMask(openMask(m0, w, h), w, h, n * 0.006);
      for (let k = 0; k < Math.min(3, comps.length); k++) {
        const cp = comps[k], id = cp.id;
        // trabalha só na região deste pedaço (bem mais rápido)
        const pad = 6;
        const bx0 = Math.max(0, cp.x0 - pad), by0 = Math.max(0, cp.y0 - pad), bx1 = Math.min(w - 1, cp.x1 + pad), by1 = Math.min(h - 1, cp.y1 + pad);
        const sw = bx1 - bx0 + 1, sh = by1 - by0 + 1, sn = sw * sh;
        const vr = [], vb = [];
        for (let y = cp.y0; y <= cp.y1; y += 2) for (let x = cp.x0; x <= cp.x1; x += 2) { const i = y * w + x; if (lab[i] === id) { vr.push(cR[i]); vb.push(cB[i]); } }
        if (vr.length < 20) continue;
        vr.sort((p, q) => p - q); vb.sort((p, q) => p - q);
        const mr = vr[vr.length >> 1], mb = vb[vb.length >> 1];
        if (mr - mb > 0.6) continue; // pedaço avermelhado demais para ser papel
        const ref = new Uint8Array(sn), subL = new Float32Array(sn);
        for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
          const i = (y + by0) * w + x + bx0, j = y * sw + x;
          subL[j] = L[i];
          if (lab[i] === id && Math.abs(cR[i] - mr) + Math.abs(cB[i] - mb) < 0.25) ref[j] = 1;
        }
        const on = openMask(ref, sw, sh);
        const L2 = labelMask(on, sw, sh, n * 0.006);
        if (!L2.comps.length) continue;
        const r = quadFromComponent(L2.lab, L2.comps[0].id, sw, sh, on, subL);
        if (!r) continue;
        // um retângulo que encosta na borda da FOTO (não do recorte) é descartado
        const qf = r.quad.map(p => ({ x: p.x + bx0, y: p.y + by0 }));
        if (qf.some(p => p.x < 3 || p.y < 3 || p.x > w - 4 || p.y > h - 4)) continue;
        if ((bx0 === 0 && cp.x0 <= 1) || (by0 === 0 && cp.y0 <= 1) || (bx1 === w - 1 && cp.x1 >= w - 2) || (by1 === h - 1 && cp.y1 >= h - 2)) continue;
        if (quadArea(qf) > w * h * 0.75) continue;
        r.quad = qf;
        if (Engine._debug) r.on = null;
        cands.push(r);
      }
    }
    // tira repetidos (o mesmo retângulo achado em níveis diferentes)
    cands.sort((a, b) => b.edge - a.edge);
    const out = [];
    for (const c of cands) {
      const diag = Math.hypot(c.quad[0].x - c.quad[2].x, c.quad[0].y - c.quad[2].y);
      const dup = out.some(o => { let best = 1e9; for (let s = 0; s < 4; s++) { let dd = 0; for (let k = 0; k < 4; k++) dd = Math.max(dd, dist(o.quad[(k + s) % 4], c.quad[k])); best = Math.min(best, dd); } return best < diag * 0.04; });
      if (!dup) out.push(c);
      if (out.length >= 3) break;
    }
    return out;
  }

  function detectCard(img) { const c = detectCards(img); return c.length ? c[0] : null; }

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

  const cornerMasks = {};
  function cornerMask(w, h) {
    const key = w + 'x' + h; if (cornerMasks[key]) return cornerMasks[key];
    const m = new Uint8Array(w * h), r = w * 0.1, b = Math.max(1, Math.round(w * 0.02));
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < b || y < b || x >= w - b || y >= h - b) continue;
      const cx = x < r ? r : x > w - 1 - r ? w - 1 - r : x, cy = y < r ? r : y > h - 1 - r ? h - 1 - r : y;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * w + x] = 1;
    }
    return (cornerMasks[key] = m);
  }

  /** Vetor de comparação: RGB com balanço de branco, desfocado, normalizado. */
  function features(rgb, w, h) {
    const n = w * h, out = new Float32Array(n * 3);
    for (let c = 0; c < 3; c++) {
      const ch = new Float32Array(n), tmp = new Float32Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; let s = rgb[i * 3 + c], k = 1;
        if (x > 0) { s += rgb[(i - 1) * 3 + c]; k++; } if (x < w - 1) { s += rgb[(i + 1) * 3 + c]; k++; }
        tmp[i] = s / k;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = y * w + x; let s = tmp[i], k = 1;
        if (y > 0) { s += tmp[i - w]; k++; } if (y < h - 1) { s += tmp[i + w]; k++; }
        ch[i] = s / k;
      }
      // percentil 97 por histograma (bem mais rápido que ordenar)
      const hist = new Uint32Array(256);
      for (let i = 0; i < n; i++) { let v = ch[i] | 0; if (v > 255) v = 255; hist[v]++; }
      let acc = 0, wv = 255; for (let t = 0; t < 256; t++) { acc += hist[t]; if (acc >= n * 0.97) { wv = t + 0.5; break; } }
      const white = Math.max(wv, 1);
      for (let i = 0; i < n; i++) out[c * n + i] = Math.min(ch[i] / white, 1.1);
    }
    // fora dos cantos arredondados e da beirada aparece o fundo: não entra na comparação
    const msk = cornerMask(w, h);
    let mean = 0, cnt = 0;
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) if (msk[i]) { mean += out[c * n + i]; cnt++; }
    mean /= cnt || 1;
    let sd = 0;
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) { const k = c * n + i; if (msk[i]) { out[k] -= mean; sd += out[k] * out[k]; } else out[k] = 0; }
    sd = Math.sqrt(sd / (cnt || 1)) || 1;
    for (let i = 0; i < out.length; i++) out[i] /= sd;
    return out;
  }

  /**
   * Compara com as 52 cartas em 4 posições: normal, girada 180°, espelhada e espelhada+180°
   * (a câmera da frente pode entregar a imagem espelhada).
   * rot: 0 normal, 1 = 180°, 2 = espelho, 3 = espelho + 180°.
   */
  const mirrorMaps = {};
  function mirrorMap(w, h) {
    const k = w + 'x' + h; if (mirrorMaps[k]) return mirrorMaps[k];
    const m = new Int32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[y * w + x] = y * w + (w - 1 - x);
    return (mirrorMaps[k] = m);
  }
  function match(f, templates, w, h) {
    const N = f.length, P = N / 3, res = [];
    const mm = w && h ? mirrorMap(w, h) : null;
    for (const t of templates) {
      const g = t.feat; let s0 = 0, s1 = 0, s2 = 0, s3 = 0;
      for (let c = 0; c < 3; c++) {
        const b = c * P;
        if (mm) for (let p = 0; p < P; p++) { const gv = g[b + p], q = mm[p]; s0 += f[b + p] * gv; s1 += f[b + P - 1 - p] * gv; s2 += f[b + q] * gv; s3 += f[b + P - 1 - q] * gv; }
        else for (let p = 0; p < P; p++) { const gv = g[b + p]; s0 += f[b + p] * gv; s1 += f[b + P - 1 - p] * gv; }
      }
      const sc = [s0 / N, s1 / N, mm ? s2 / N : -9, mm ? s3 / N : -9];
      let rot = 0; for (let k = 1; k < 4; k++) if (sc[k] > sc[rot]) rot = k;
      res.push({ id: t.id, score: sc[rot], rot });
    }
    res.sort((a, b) => b.score - a.score);
    return { best: res[0], second: res[1], all: res };
  }

  /** Semelhança com UMA carta numa orientação (rot 0..3, como em match). */
  function scoreOne(f, g, rot, w, h) {
    const N = f.length, P = N / 3, mm = rot >= 2 ? mirrorMap(w, h) : null;
    let s = 0;
    for (let c = 0; c < 3; c++) {
      const b = c * P;
      for (let p = 0; p < P; p++) {
        const q = rot === 0 ? p : rot === 1 ? P - 1 - p : rot === 2 ? mm[p] : P - 1 - mm[p];
        s += f[b + q] * g[b + p];
      }
    }
    return s / N;
  }
  /**
   * Ajusta os 4 cantos usando a própria carta como régua: mexe cada canto um pouco
   * e fica com a posição em que o recorte mais se parece com a carta guardada.
   */
  function refineQuadByMatch(img, quad, g, rot, w, h, opts_steps) {
    let q = quad.map(p => ({ x: p.x, y: p.y }));
    const ev = qq => scoreOne(features(warp(img, qq, w, h), w, h), g, rot, w, h);
    let best = ev(q);
    const short = Math.min(dist(q[0], q[1]), dist(q[1], q[2]));
    for (const frac of (opts_steps || [0.08, 0.04, 0.02, 0.01])) {
      const d = Math.max(0.5, short * frac);
      for (let sweep = 0; sweep < 3; sweep++) {
        let improved = false;
        for (let k = 0; k < 4; k++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
          const t = q.map(p => ({ x: p.x, y: p.y })); t[k].x += dx; t[k].y += dy;
          const sc = ev(t);
          if (sc > best + 1e-4) { best = sc; q = t; improved = true; }
        }
        if (!improved) break;
      }
    }
    return { quad: q, score: best };
  }

  /** Reordena os cantos para a posição da carta guardada (desfaz giro/espelho). */
  function orient(q, rot) {
    if (rot === 1) return [q[2], q[3], q[0], q[1]];
    if (rot === 2) return [q[1], q[0], q[3], q[2]];
    if (rot === 3) return [q[3], q[2], q[1], q[0]];
    return q;
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
  /**
   * Separa a tinta da assinatura.
   * cap: foto da carta (RGB float W×H) já alinhada; tpl: carta limpa (RGB float W×H).
   * Pega o traço inteiro, inclusive as partes fracas, por "histerese": começa nos pontos de tinta
   * forte e cresce para os pontos fracos ligados a eles. A transparência de cada ponto vem da
   * escuridão real da tinta na foto (reproduz o traço como ele é).
   */
  const tplCache = new WeakMap();
  function extractSignature(cap, tpl, W, H, opts) {
    opts = opts || {};
    if (!opts.noAlign) cap = alignToTemplate(cap, tpl, W, H);
    const n = W * H;
    // tudo o que depende só da carta guardada é calculado uma vez e reaproveitado
    const cacheKey = (opts.r || 2) + ':' + W + 'x' + H;
    let T = tplCache.get(tpl);
    if (!T || T.key !== cacheKey) {
      const tl = new Float32Array(n);
      for (let i = 0; i < n; i++) tl[i] = 0.299 * tpl[i * 3] + 0.587 * tpl[i * 3 + 1] + 0.114 * tpl[i * 3 + 2];
      const tmin = minFilter(tl, W, H, opts.r || 2);
      const tc = [0, 1, 2].map(c => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = tpl[i * 3 + c]; return minFilter(a, W, H, opts.r || 2); });
      const dom = new Uint8Array(n);
      for (let i = 0; i < n; i++) { const r = tpl[i * 3], g = tpl[i * 3 + 1], b = tpl[i * 3 + 2]; dom[i] = r >= g && r >= b ? 0 : g >= b ? 1 : 2; }
      const tb = boxSum(integral(tl, W, H), W, H, 1);
      const edge = new Float32Array(n);
      for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        const gx = (tb[i - W + 1] + 2 * tb[i + 1] + tb[i + W + 1]) - (tb[i - W - 1] + 2 * tb[i - 1] + tb[i + W - 1]);
        const gy = (tb[i + W - 1] + 2 * tb[i + W] + tb[i + W + 1]) - (tb[i - W - 1] + 2 * tb[i - W] + tb[i - W + 1]);
        if (Math.abs(gx) + Math.abs(gy) > 9 * 70) edge[i] = 1;
      }
      const edgeD = boxSum(integral(edge, W, H), W, H, 3);
      T = { key: cacheKey, tl, tmin, tc, dom, edgeD };
      tplCache.set(tpl, T);
    }
    const { tl, tmin, tc, dom, edgeD } = T;
    // --- dedo: detectado pela COR (pele), com o balanço de branco geral da foto ---
    const wb = [0, 0, 0];
    {
      const rs_ = [[], [], []];
      for (let i = 0; i < n; i += 3) if (edgeD[i] === 0 && tl[i] > 200) for (let c = 0; c < 3; c++) rs_[c].push(cap[i * 3 + c] / Math.max(tpl[i * 3 + c], 1));
      for (let c = 0; c < 3; c++) { const v = rs_[c].sort((p, q) => p - q); wb[c] = v.length ? Math.max(v[Math.floor(v.length * 0.75)], 0.01) : 1; }
    }
    const skin = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const r = cap[i * 3] / wb[0], g = cap[i * 3 + 1] / wb[1], b = cap[i * 3 + 2] / wb[2];
      const L = 0.299 * r + 0.587 * g + 0.114 * b;
      if (L < 25) continue;
      const cr_ = r / L, cb_ = b / L, tr = tpl[i * 3] / Math.max(tl[i], 1);
      if (tl[i] > 150 && cr_ - cb_ > 0.3 && cr_ - tr > 0.12) skin[i] = 1;                  // pele sobre papel branco
      else if (tl[i] <= 150 && L > tl[i] * 1.5 + 30 && g > tpl[i * 3 + 1] * 2 + 50 && cr_ - cb_ > 0.25) skin[i] = 1; // pele sobre naipe/desenho
    }
    const skinD0 = boxSum(integral(skin, W, H), W, H, 4);
    const skinCore = new Float32Array(n); for (let i = 0; i < n; i++) if (skinD0[i] > 30) skinCore[i] = 1;
    { // dedo é uma região grande: descarta manchas pequenas
      const lab = new Int32Array(n), st = new Int32Array(n); let cur = 0;
      for (let i = 0; i < n; i++) {
        if (!skinCore[i] || lab[i]) continue;
        cur++; let sp = 0; st[sp++] = i; lab[i] = cur; const list = [];
        while (sp) { const p = st[--sp]; list.push(p); const x = p % W;
          if (x > 0 && skinCore[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; st[sp++] = p - 1; }
          if (x < W - 1 && skinCore[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; st[sp++] = p + 1; }
          if (p >= W && skinCore[p - W] && !lab[p - W]) { lab[p - W] = cur; st[sp++] = p - W; }
          if (p < n - W && skinCore[p + W] && !lab[p + W]) { lab[p + W] = cur; st[sp++] = p + W; } }
        if (list.length < n * 0.006) for (const p of list) skinCore[p] = 0;
      }
    }
    // a borda borrada do dedo parece tinta: exclui uma margem em volta
    const skinD = boxSum(integral(skinCore, W, H), W, H, Math.round(W * 0.035));
    const R = Math.round(W * 0.05);
    const ratio = new Float32Array(n).fill(9);
    let gains = null;
    for (let pass = 0; pass < 2; pass++) {
      const paper = new Float32Array(n);
      for (let i = 0; i < n; i++) if (edgeD[i] === 0 && tl[i] > 170 && ratio[i] > 0.85 && ratio[i] !== 8 && skinD[i] === 0) paper[i] = 1;
      const pc = boxSum(integral(paper, W, H), W, H, R);
      let totP = 0; for (let i = 0; i < n; i++) totP += paper[i];
      gains = [];
      for (let c = 0; c < 3; c++) {
        const av = new Float32Array(n), bv = new Float32Array(n);
        let ga = 0, gb = 0;
        for (let i = 0; i < n; i++) if (paper[i]) { av[i] = cap[i * 3 + c]; bv[i] = tpl[i * 3 + c]; ga += av[i]; gb += bv[i]; }
        const gGlobal = totP > 0 ? ga / Math.max(gb, 1) : 1;
        const sa = boxSum(integral(av, W, H), W, H, R), sb = boxSum(integral(bv, W, H), W, H, R);
        const g = new Float32Array(n);
        for (let i = 0; i < n; i++) g[i] = pc[i] > 60 ? sa[i] / Math.max(sb[i], 1) : gGlobal;
        gains.push(g);
      }
      ratio.fill(9);
      for (let i = 0; i < n; i++) {
        const colored = tl[i] < 170;
        const e = colored ? tc[dom[i]][i] : tmin[i];
        if (e < 45) continue; // embaixo de partes pretas do desenho a tinta não aparece
        const r = cap[i * 3] / Math.max(gains[0][i], 0.02), g = cap[i * 3 + 1] / Math.max(gains[1][i], 0.02), b = cap[i * 3 + 2] / Math.max(gains[2][i], 0.02);
        if (colored) { ratio[i] = (dom[i] === 0 ? r : dom[i] === 1 ? g : b) / e; continue; }
        if (tl[i] > 150) { // pele (dedos) sobre o papel
          const rr = r / (tpl[i * 3] + 1), rg = g / (tpl[i * 3 + 1] + 1), rb = b / (tpl[i * 3 + 2] + 1);
          if (rr - rb > 0.2 && rg > 0.33 && rr > 0.5) { ratio[i] = 8; continue; }
        }
        ratio[i] = (0.299 * r + 0.587 * g + 0.114 * b) / e;
      }
    }
    for (let i = 0; i < n; i++) if (skinD[i] > 0) ratio[i] = 9;
    // suaviza um pouco o mapa (tira o ruído sem apagar traço fino)
    const valid = new Float32Array(n), rv = new Float32Array(n);
    for (let i = 0; i < n; i++) if (ratio[i] < 5) { valid[i] = 1; rv[i] = ratio[i]; }
    const sv = boxSum(integral(valid, W, H), W, H, 1), sr = boxSum(integral(rv, W, H), W, H, 1);
    const rs = new Float32Array(n).fill(9);
    for (let i = 0; i < n; i++) if (valid[i]) rs[i] = sr[i] / sv[i];
    // ruído, medido no papel limpo
    const samp = [];
    for (let i = 0; i < n; i += 5) if (edgeD[i] === 0 && tl[i] > 170 && rs[i] < 5) samp.push(rs[i]);
    samp.sort((p, q) => p - q);
    const med = samp.length ? samp[samp.length >> 1] : 1;
    const dev = samp.map(v => Math.abs(v - med)).sort((p, q) => p - q);
    const sigma = dev.length ? 1.4826 * dev[dev.length >> 1] : 0.02;
    const weakT = med - Math.max(0.035, 3 * sigma);
    const strongT = med - Math.max(0.09, 6 * sigma);
    // margem externa (fundo atrás da carta)
    const m0 = Math.round(W * 0.008);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x < m0 || y < m0 || x >= W - m0 || y >= H - m0) { rs[y * W + x] = 9; ratio[y * W + x] = 9; }
    // histerese: começa na tinta forte e segue o traço pelas partes fracas
    // sobre áreas coloridas (naipes vermelhos, figuras) a câmera muda um pouco a cor: exige tinta mais escura
    const wT = i => tl[i] < 170 ? weakT - 0.05 : weakT;
    const sT = i => tl[i] < 170 ? strongT - 0.1 : strongT;
    const cand = new Uint8Array(n); for (let i = 0; i < n; i++) if (rs[i] < wT(i)) cand[i] = 1;
    const lab = new Int32Array(n), stack = new Int32Array(n), keep = new Uint8Array(n);
    const band = Math.round(W * 0.04);
    let cur = 0;
    for (let i = 0; i < n; i++) {
      if (!cand[i] || lab[i]) continue;
      cur++; let sp = 0; stack[sp++] = i; lab[i] = cur;
      const list = []; let seeds = 0, minx = W, maxx = 0, miny = H, maxy = 0, touch = false;
      while (sp) {
        const p = stack[--sp]; list.push(p);
        if (rs[p] < sT(p)) seeds++;
        const x = p % W, y = (p / W) | 0;
        if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
        if (x < band || y < band || x >= W - band || y >= H - band) touch = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          const q = yy * W + xx; if (cand[q] && !lab[q]) { lab[q] = cur; stack[sp++] = q; }
        }
      }
      const area = list.length, bbox = (maxx - minx + 1) * (maxy - miny + 1);
      if (seeds < 4 || area < 25) continue;
      if (touch && area > 500 && area / bbox > 0.5) continue; // mancha na borda (dedo/sombra), não traço
      for (const p of list) keep[p] = 1;
    }
    // escuridão da tinta, com nível automático (tinta fraca na foto vira tinta de verdade)
    const kd = boxSum(integral(keep, W, H), W, H, 1);
    const dk = [];
    for (let i = 0; i < n; i++) if (keep[i]) dk.push(med - (0.5 * ratio[i] + 0.5 * rs[i]));
    dk.sort((p, q) => p - q);
    const dmax = dk.length ? Math.max(dk[Math.floor(dk.length * 0.9)], med - weakT + 0.05) : 0.5;
    const d0 = (med - weakT) * 0.6;
    const alpha = new Uint8ClampedArray(n);
    let cr = 0, cg = 0, cb = 0, ck = 0, count = 0;
    for (let i = 0; i < n; i++) {
      if (kd[i] === 0 || ratio[i] > 5 || rs[i] > 5) continue;
      const d = med - (0.5 * ratio[i] + 0.5 * rs[i]);
      let a = (d - d0) / (dmax - d0);
      if (a <= 0) continue; if (a > 1) a = 1;
      alpha[i] = Math.round(Math.pow(a, 0.75) * 255);
      if (keep[i]) count++;
      if (keep[i] && rs[i] < strongT && tl[i] > 170) {
        cr += cap[i * 3] / Math.max(gains[0][i], 0.02); cg += cap[i * 3 + 1] / Math.max(gains[1][i], 0.02); cb += cap[i * 3 + 2] / Math.max(gains[2][i], 0.02); ck++;
      }
    }
    // quanto da região da assinatura dava para ler (fora de partes pretas do desenho e do dedo)
    let bx0 = W, bx1 = 0, by0 = H, by1 = 0;
    for (let i = 0; i < n; i++) if (keep[i]) { const x = i % W, y = (i / W) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
    let hidden = 0, tot = 0;
    if (bx1 > bx0) {
      const ex = Math.round((bx1 - bx0) * 0.08), ey = Math.round((by1 - by0) * 0.08);
      for (let y = Math.max(m0, by0 - ey); y <= Math.min(H - 1 - m0, by1 + ey); y++) for (let x = Math.max(m0, bx0 - ex); x <= Math.min(W - 1 - m0, bx1 + ex); x++) {
        const i = y * W + x; tot++; if ((tl[i] < 170 ? tc[dom[i]][i] : tmin[i]) < 45 || skinD[i] > 0) hidden++;
      }
    }
    const hiddenFrac = tot ? hidden / tot : 0;
    let color = [22, 22, 26];
    if (ck > 20) { const r = cr / ck, g = cg / ck, b = cb / ck; if (b > r * 1.25 && b > g * 1.05) color = [24, 38, 120]; }
    return { alpha, mask: keep, color, count, W, H, sigma, weakT, strongT, hiddenFrac };
  }

  /** Quanto duas leituras da assinatura concordam (0 a 1), tolerando 1 px de diferença. */
  function maskAgreement(a, b, W, H) {
    const da = boxSum(integral(a, W, H), W, H, 1), db = boxSum(integral(b, W, H), W, H, 1);
    let na = 0, nb = 0, ha = 0, hb = 0;
    for (let i = 0; i < W * H; i++) {
      if (a[i]) { na++; if (db[i] > 0) ha++; }
      if (b[i]) { nb++; if (da[i] > 0) hb++; }
    }
    if (!na || !nb) return 0;
    return Math.min(ha / na, hb / nb);
  }

  return { cardRect, detectCard, detectCards, orient, refineQuadByMatch, scoreOne, snapQuad, warp, features, match, sharpness, imageToRGB, templateFeatures, alignToTemplate, extractSignature, maskAgreement, homography };
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
  // encosta os lados na borda real, agora em alta resolução (só um pequeno ajuste)
  const n = bw * bh, L = new Float32Array(n), dd = im.data;
  for (let i = 0, j = 0; i < n; i++, j += 4) L[i] = 0.299 * dd[j] + 0.587 * dd[j + 1] + 0.114 * dd[j + 2];
  const sn = Engine.snapQuad(local, L, bw, bh, 0.025);
  if (sn) quad = sn;
  return { im, quad };
};
