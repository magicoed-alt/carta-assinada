'use strict';
/*
  Captura: reconhece a carta e só termina quando a ASSINATURA está bem lida.
  - junta vários quadros nítidos da carta, cada um alinhado à carta guardada;
  - tira a média (some o ruído da foto escura);
  - lê a assinatura em duas metades independentes dos quadros: só aprova se as duas leituras
    concordarem (traço estável = assinatura real e completa).
*/
const Capture = (() => {
  const SMALL_W = 300, MW = 60, MH = 84, SW = 600, SH = 840;
  const MAXF = 6, MIN_W = 140, AGREE = 0.6;

  function create(templates, cardById) {
    const tplById = Object.fromEntries(templates.map(t => [t.id, t]));
    const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });
    const big = document.createElement('canvas'), bctx = big.getContext('2d', { willReadFrequently: true });
    let streakId = null, streak = 0, id = null, tpl = null, frames = [], maxSharp = 0, misses = 0, t0 = 0;
    let other = null, otherStreak = 0, tries = 0, lockRot = null;
    const info = { phase: 'none', label: '', frames: 0, width: 0, agree: 0, ink: 0, reason: '' };

    function reset() {
      streakId = null; streak = 0; id = null; tpl = null; frames = []; maxSharp = 0; misses = 0;
      other = null; otherStreak = 0; tries = 0; lockRot = null;
      Object.assign(info, { phase: 'none', label: '', frames: 0, width: 0, agree: 0, ink: 0, reason: '' });
    }

    function average(list) {
      const n = SW * SH * 3, out = new Float32Array(n);
      for (const f of list) for (let i = 0; i < n; i++) out[i] += f.data[i];
      for (let i = 0; i < n; i++) out[i] /= list.length;
      return out;
    }

    function evaluate() {
      tries++;
      const all = average(frames);
      const A = average(frames.filter((_, i) => i % 2 === 0)), B = average(frames.filter((_, i) => i % 2 === 1));
      const court = /^[jqk]/.test(id);
      const sA = Engine.extractSignature(A, tpl, SW, SH, { noAlign: true, r: 2 });
      const sB = Engine.extractSignature(B, tpl, SW, SH, { noAlign: true, r: 2 });
      const sF = Engine.extractSignature(all, tpl, SW, SH, { noAlign: true, r: 2 });
      const agree = Engine.maskAgreement(sA.mask, sB.mask, SW, SH);
      info.agree = agree; info.ink = sF.count;
      const enoughInk = sF.count >= SW * SH * 0.001;
      if (enoughInk && agree >= AGREE) {
        info.phase = 'done';
        const quality = sF.hiddenFrac < 0.12 ? 'ok' : 'parcial';
        return { id, sig: sF, avg: all, court, agree, quality, hidden: sF.hiddenFrac };
      }
      info.last = { id, sig: sF, avg: all, sA, sB };
      info.reason = !enoughInk ? 'sem assinatura visível' : 'assinatura instável (' + agree.toFixed(2) + ')';
      // tenta de novo com quadros novos
      frames = []; maxSharp *= 0.8; t0 = performance.now();
      return null;
    }

    // desempate em alta resolução entre as cartas mais parecidas (ex.: 3♠ × 3♣)
    const HW = 120, HH = 168, hiFeat = {};
    function hiResMatch(src, vw, vh, det, m, sw) {
      const s = vw / sw;
      const q = det.quad.map(p => ({ x: p.x * s, y: p.y * s }));
      const r = Engine.cropRefine(src, vw, vh, q, big, bctx);
      if (!r) return null;
      const f = Engine.features(Engine.warp(r.im, r.quad, HW, HH), HW, HH);
      const cands = m.all.slice(0, 4).map(c => {
        if (!hiFeat[c.id]) hiFeat[c.id] = Engine.templateFeatures(cardById[c.id].img, HW, HH);
        return { id: c.id, feat: hiFeat[c.id] };
      });
      const hm = Engine.match(f, cands, HW, HH);
      // a margem em alta resolução vale como margem (escala parecida com a normal)
      return { best: hm.best, second: hm.second, all: hm.all, hi: true };
    }

    /** Processa um quadro. Devolve o resultado quando a assinatura estiver aprovada. */
    const frameCv = document.createElement('canvas'), fctx = frameCv.getContext('2d');
    function step(src, vw, vh) {
      // congela o quadro: tudo neste passo usa exatamente a mesma imagem
      if (typeof HTMLVideoElement !== 'undefined' && src instanceof HTMLVideoElement) {
        if (frameCv.width !== vw || frameCv.height !== vh) { frameCv.width = vw; frameCv.height = vh; }
        fctx.drawImage(src, 0, 0, vw, vh);
        src = frameCv;
      }
      const sw = SMALL_W, sh = Math.round(SMALL_W * vh / vw);
      if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
      sctx.drawImage(src, 0, 0, sw, sh);
      const img = sctx.getImageData(0, 0, sw, sh);
      // pode haver mais de um retângulo claro: fica com o que mais parece uma das 52 cartas
      let det = null, m = null;
      for (const c of Engine.detectCards(img)) {
        const mc = Engine.match(Engine.features(Engine.warp(img, c.quad, MW, MH), MW, MH), templates, MW, MH);
        if (!m || mc.best.score > m.best.score) { m = mc; det = c; }
      }
      // cantos imprecisos (dedo, fundo claro): ajusta usando a própria carta como régua
      if (det && m.best.score > 0.4 && m.best.score < 0.85) {
        let bestR = null;
        // já sabendo a carta, ajusta só contra ela (mais rápido)
        const known = id ? m.all.filter(a => a.id === id) : [];
        const list = known.length ? known : m.all.slice(0, 2);
        for (const cand of list) {
          const r = Engine.refineQuadByMatch(img, det.quad, tplById[cand.id].feat, cand.rot, MW, MH, known.length ? [0.04, 0.02, 0.01] : null);
          if (!bestR || r.score > bestR.score) bestR = r;
        }
        if (bestR.score > m.best.score + 0.02) {
          det = Object.assign({}, det, { quad: bestR.quad });
          m = Engine.match(Engine.features(Engine.warp(img, det.quad, MW, MH), MW, MH), templates, MW, MH);
        }
      }
      info.det = det; info.match = m; info.small = small;

      if (!id) {
        if (!det) { streak = 0; streakId = null; info.phase = 'none'; return null; }
        info.phase = 'seen';
        if (m.best.score > 0.5 && m.best.score - m.second.score < 0.06) {
          const hm = hiResMatch(src, vw, vh, det, m, sw);
          if (hm) { m = hm; info.match = hm; }
        }
        const ok = m.best.score > 0.66 && m.best.score - m.second.score > 0.035;
        if (!ok) { streak = 0; streakId = null; return null; }
        if (m.best.id === streakId) streak++; else { streakId = m.best.id; streak = 1; }
        if (streak >= 3) {
          id = m.best.id; t0 = performance.now(); frames = []; maxSharp = 0; misses = 0;
          tpl = Engine.imageToRGB(cardById[id].img, SW, SH, '#fff');
          info.label = cardById[id].label; info.phase = 'reading'; info.reason = '';
        }
        return null;
      }

      // já sabemos a carta: juntando quadros para a assinatura
      info.phase = 'reading';
      if (!det || m.best.score < 0.45) { if (++misses > 20) reset(); return null; }
      if (m.best.id !== id) {
        if (m.best.id === other) otherStreak++; else { other = m.best.id; otherStreak = 1; }
        if (otherStreak >= 4 && m.best.score - m.second.score > 0.04) reset(); // trocou de carta
        return null;
      }
      misses = 0; otherStreak = 0;
      // orientação travada no primeiro quadro bom (cartas quase simétricas não podem alternar)
      let rot = m.best.rot;
      if (lockRot !== null && rot !== lockRot) {
        const f = Engine.features(Engine.warp(img, det.quad, MW, MH), MW, MH);
        const sl = Engine.scoreOne(f, tplById[id].feat, lockRot, MW, MH);
        if (sl > m.best.score - 0.06) rot = lockRot; else { info.reason = 'carta girou'; return null; }
      }
      // só entra na média quadro em que o recorte bate muito bem com a carta
      if (m.best.score < 0.72) { info.reason = 'enquadramento ruim (' + m.best.score.toFixed(2) + ')'; return null; }
      // carta quase igual de cabeça para baixo (ex.: 4♠): usa a posição em que ela estava em pé diante da câmera
      if (lockRot === null) {
        const f = Engine.features(Engine.warp(img, det.quad, MW, MH), MW, MH);
        const alt = rot ^ 1, sa = Engine.scoreOne(f, tplById[id].feat, alt, MW, MH), sr = Engine.scoreOne(f, tplById[id].feat, rot, MW, MH);
        if (Math.abs(sa - sr) < 0.03) {
          const oq = Engine.orient(det.quad, rot);
          if ((oq[0].y + oq[1].y) / 2 > (oq[2].y + oq[3].y) / 2) rot = alt;
        }
      }
      const s = vw / sw;
      const q = Engine.orient(det.quad.map(p => ({ x: p.x * s, y: p.y * s })), rot);
      const r = Engine.cropRefine(src, vw, vh, q, big, bctx);
      if (!r) return null;
      const Q = r.quad;
      const width = (Math.hypot(Q[1].x - Q[0].x, Q[1].y - Q[0].y) + Math.hypot(Q[2].x - Q[3].x, Q[2].y - Q[3].y)) / 2;
      info.width = Math.round(width);
      if (width < MIN_W) { info.reason = 'carta longe (aproxime)'; return null; }
      const w = Engine.warp(r.im, Q, SW, SH);
      const sharp = Engine.sharpness(w, SW, SH);
      if (sharp < maxSharp * 0.55) { info.reason = 'tremido'; return null; }
      if (sharp > maxSharp) { maxSharp = sharp; frames = frames.filter(f => f.sharp >= maxSharp * 0.55); }
      const al = Engine.alignToTemplate(w, tpl, SW, SH);
      const data = new Uint8ClampedArray(al.length);
      for (let i = 0; i < al.length; i++) data[i] = al[i];
      frames.push({ data, sharp });
      if (lockRot === null) lockRot = rot;
      info.frames = frames.length; info.reason = '';
      if (frames.length >= MAXF || (frames.length >= 4 && performance.now() - t0 > 2500)) return evaluate();
      return null;
    }

    return { step, reset, info, SW, SH };
  }
  return { create, SW, SH };
})();
if (typeof window !== 'undefined') window.Capture = Capture;
