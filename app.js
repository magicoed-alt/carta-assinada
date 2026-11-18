'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const video = $('cam'), card = $('card'), packet = $('packet');
  const dot = $('dot'), lbl = $('lbl'), hint = $('hint');
  const DEBUG = /ensaio/.test(location.search);

  const SMALL_W = 360, MW = 60, MH = 84, SW = 500, SH = 700;
  const small = document.createElement('canvas'), sctx = small.getContext('2d', { willReadFrequently: true });
  const big = document.createElement('canvas'), bctx = big.getContext('2d', { willReadFrequently: true });

  // estados: load, needtap, capture, ready, entering, back, flipping, face, folding, folded, gone
  let state = 'load';
  let templates = [], backImg = null;
  let stream = null, loopTimer = null, dotTimer = null;
  let streakId = null, streak = 0, refine = null;
  let capturedId = null;

  // ---------- layout ----------
  function layout() {
    const cw = Math.round(Math.min(380, innerWidth * 0.88));
    const ch = Math.round(cw * 88 / 63);
    const st = document.documentElement.style;
    st.setProperty('--cw', cw + 'px'); st.setProperty('--ch', ch + 'px');
    st.setProperty('--r', Math.round(cw * 0.055) + 'px');
    return { cw, ch };
  }
  addEventListener('resize', layout);
  layout();

  // ---------- sinais discretos ----------
  function setDot(mode, text) {
    dot.className = mode === 'off' ? '' : mode;
    lbl.textContent = text || '';
    clearTimeout(dotTimer);
    if (mode === 'ok') dotTimer = setTimeout(() => { dot.className = ''; lbl.textContent = ''; }, 8000);
  }
  function haptic() {
    try { if (navigator.vibrate) { navigator.vibrate(70); return; } } catch (e) {}
    try { $('hap').click(); } catch (e) {} // iPhone (iOS 18+): vibração do "switch"
  }

  // ---------- tela sempre acesa ----------
  let wl = null;
  async function wake() {
    try { if ('wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (e) {}
  }

  // ---------- câmera ----------
  function stopCamera() {
    clearTimeout(loopTimer);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.srcObject = null;
  }

  async function startCapture() {
    resetVisual();
    stopCamera();
    streak = 0; streakId = null; refine = null; capturedId = null;
    setDot('off'); hint.textContent = '';
    state = 'capture';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      video.srcObject = stream;
      await video.play();
      if (DEBUG) $('dbg').style.display = 'block';
      loop();
    } catch (e) {
      console.error(e);
      state = 'needtap';
      hint.textContent = 'toque para ativar a câmera';
    }
  }

  function loop() {
    if (state !== 'capture') return;
    try { step(); } catch (e) { console.error(e); }
    loopTimer = setTimeout(loop, 70);
  }

  function step() {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) return;
    const sw = SMALL_W, sh = Math.round(SMALL_W * vh / vw);
    if (small.width !== sw || small.height !== sh) { small.width = sw; small.height = sh; }
    sctx.drawImage(video, 0, 0, sw, sh);
    const img = sctx.getImageData(0, 0, sw, sh);
    const det = Engine.detectCard(img);
    let m = null;
    if (det) m = Engine.match(Engine.features(Engine.warp(img, det.quad, MW, MH), MW, MH), templates);
    if (DEBUG) drawDebug(det, m);

    if (refine) {
      if (det && m.best.id === refine.id && m.best.score > 0.45) grab(det, m.best.rot, vw, vh, sw);
      else refine.misses++;
      if (refine.best && (refine.frames >= 5 || refine.misses > 5 || performance.now() - refine.t0 > 1500)) finishCapture();
      else if (!refine.best && refine.misses > 8) { refine = null; streak = 0; }
      return;
    }
    if (!det) { streak = 0; streakId = null; setDot('off'); return; }
    setDot('seek');
    const ok = m.best.score > 0.55 && m.best.score - m.second.score > 0.04;
    if (!ok) { streak = 0; streakId = null; return; }
    if (m.best.id === streakId) streak++; else { streakId = m.best.id; streak = 1; }
    if (streak >= 3) {
      refine = { id: m.best.id, best: null, bestSharp: -1, frames: 0, misses: 0, t0: performance.now() };
      grab(det, m.best.rot, vw, vh, sw);
    }
  }

  // pega o recorte em alta resolução (o mais nítido dos próximos quadros)
  function grab(det, rot, vw, vh, sw) {
    const s = vw / sw;
    let q = det.quad.map(p => ({ x: p.x * s, y: p.y * s }));
    if (rot) q = [q[2], q[3], q[0], q[1]];
    const r = Engine.cropRefine(video, vw, vh, q, big, bctx);
    if (!r) return;
    const w = Engine.warp(r.im, r.quad, SW, SH);
    const sh = Engine.sharpness(w, SW, SH);
    if (sh > refine.bestSharp) { refine.bestSharp = sh; refine.best = w; }
    refine.frames++;
  }

  async function finishCapture() {
    const r = refine; refine = null;
    state = 'processing';
    stopCamera();
    $('dbg').style.display = 'none';
    const c = CARD_BY_ID[r.id];
    const tpl = Engine.imageToRGB(c.img, SW, SH, '#fff');
    const sig = Engine.extractSignature(r.best, tpl, SW, SH, { court: /^[jqk]/.test(r.id) });
    const faceURL = await composeFace(c, sig);
    await prepareCard(faceURL);
    capturedId = r.id;
    state = 'ready';
    setDot('ok', c.label);
    haptic();
  }

  // ---------- monta a face: carta limpa + assinatura ----------
  function composeFace(c, sig) {
    const W = c.img.naturalWidth || 537, H = c.img.naturalHeight || 750;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.drawImage(c.img, 0, 0, W, H);
    if (sig.count > 0) {
      const sc = document.createElement('canvas'); sc.width = sig.W; sc.height = sig.H;
      const sx = sc.getContext('2d'); const id = sx.createImageData(sig.W, sig.H);
      const [r, g, b] = sig.color;
      for (let i = 0, j = 0; i < sig.W * sig.H; i++, j += 4) { id.data[j] = r; id.data[j + 1] = g; id.data[j + 2] = b; id.data[j + 3] = sig.alpha[i]; }
      sx.putImageData(id, 0, 0);
      // a assinatura só entra onde existe carta (respeita os cantos arredondados)
      x.globalCompositeOperation = 'source-atop';
      x.imageSmoothingQuality = 'high';
      const cr = Engine.cardRect(c.img);
      x.drawImage(sc, cr.x, cr.y, cr.w, cr.h);
      x.globalCompositeOperation = 'source-over';
    }
    return new Promise(res => cv.toBlob(b => res(URL.createObjectURL(b)), 'image/png'));
  }

  let lastFaceURL = null, backURL = null;
  async function prepareCard(faceURL) {
    if (lastFaceURL) URL.revokeObjectURL(lastFaceURL);
    lastFaceURL = faceURL;
    try { await loadImage(faceURL); } catch (e) {}
    const halves = card.querySelectorAll('.half');
    const X = 'calc(var(--cw) / -2)', Y = 'calc(var(--ch) / -2)';
    const pos = [['0px 0px', X + ' 0px'], ['0px ' + Y, X + ' ' + Y]];
    const bpos = [[X + ' 0px', '0px 0px'], [X + ' ' + Y, '0px ' + Y]];
    const rad = 'var(--r)';
    halves.forEach((h, row) => {
      h.querySelectorAll('.q').forEach((q, col) => {
        const f = q.querySelector('.f'), b = q.querySelector('.b');
        f.style.backgroundImage = `url(${faceURL})`; f.style.backgroundPosition = pos[row][col];
        b.style.backgroundImage = `url(${backURL})`; b.style.backgroundPosition = bpos[row][col];
        f.style.borderRadius = b.style.borderRadius = '0';
        const corner = (row ? 'bottom' : 'top') + (col ? 'Right' : 'Left') + 'Radius';
        const mirror = (row ? 'bottom' : 'top') + (col ? 'Left' : 'Right') + 'Radius';
        f.style['border' + corner[0].toUpperCase() + corner.slice(1)] = rad;
        b.style['border' + mirror[0].toUpperCase() + mirror.slice(1)] = rad;
      });
    });
    packet.style.backgroundImage = `url(${faceURL})`;
  }

  // ---------- apresentação ----------
  function resetVisual() {
    card.classList.add('notrans');
    card.classList.remove('face', 'fold1', 'fold2');
    card.style.transition = 'none'; card.style.transform = ''; card.style.display = 'none';
    packet.style.display = 'none'; packet.style.transition = 'none'; packet.style.transform = '';
    void card.offsetWidth;
    card.classList.remove('notrans');
  }

  function enter(dx, dy) {
    state = 'entering';
    setDot('off');
    const { ch } = layout();
    let ox = 0, oy = 0;
    if (Math.abs(dx) > Math.abs(dy)) ox = (dx > 0 ? -1 : 1) * (innerWidth / 2 + ch);
    else oy = (dy >= 0 ? -1 : 1) * (innerHeight / 2 + ch);
    card.classList.add('notrans');
    card.classList.remove('face', 'fold1', 'fold2');
    card.style.display = 'block';
    card.style.transition = 'none';
    card.style.transform = `translate(${ox}px, ${oy}px) rotate(${ox ? 8 : -10}deg)`;
    void card.offsetWidth;
    card.classList.remove('notrans');
    card.style.transition = 'transform 1s cubic-bezier(.12,.8,.25,1)';
    card.style.transform = 'translate(0,0) rotate(0deg)';
    setTimeout(() => { if (state === 'entering') state = 'back'; }, 1000);
  }

  function flip() {
    state = 'flipping';
    card.classList.add('face');
    setTimeout(() => { if (state === 'flipping') state = 'face'; }, 850);
  }

  function fold() {
    state = 'folding';
    card.classList.add('fold1');
    setTimeout(() => card.classList.add('fold2'), 600);
    setTimeout(() => {
      if (state !== 'folding') return;
      const r = card.getBoundingClientRect();
      Object.assign(packet.style, {
        left: r.left + 'px', top: r.top + 'px', width: r.width / 2 + 'px', height: r.height / 2 + 'px',
        transition: 'none', transform: '', display: 'block'
      });
      card.style.display = 'none';
      state = 'folded';
    }, 1220);
  }

  // ---------- arrastar o pacotinho para fora ----------
  let drag = null;
  function startDrag(t) {
    drag = { sx: t.clientX, sy: t.clientY, ox: 0, oy: 0, pts: [{ x: t.clientX, y: t.clientY, t: performance.now() }] };
    packet.style.transition = 'none';
  }
  function moveDrag(t) {
    drag.ox = t.clientX - drag.sx; drag.oy = t.clientY - drag.sy;
    drag.pts.push({ x: t.clientX, y: t.clientY, t: performance.now() });
    if (drag.pts.length > 8) drag.pts.shift();
    packet.style.transform = `translate(${drag.ox}px, ${drag.oy}px) rotate(${drag.ox * 0.03}deg)`;
  }
  function endDrag() {
    const d = drag; drag = null;
    const now = performance.now();
    const pts = d.pts.filter(p => now - p.t < 120);
    let vx = 0, vy = 0;
    if (pts.length >= 2) { const a = pts[0], b = pts[pts.length - 1], dt = Math.max(b.t - a.t, 1); vx = (b.x - a.x) / dt; vy = (b.y - a.y) / dt; }
    const r = packet.getBoundingClientRect();
    const outside = Math.max(-r.left, -r.top, r.right - innerWidth, r.bottom - innerHeight);
    const speed = Math.hypot(vx, vy), moved = Math.hypot(d.ox, d.oy);
    if (outside > Math.min(r.width, r.height) * 0.25 || (speed > 0.7 && moved > 50)) {
      let dx = speed > 0.3 ? vx : d.ox, dy = speed > 0.3 ? vy : d.oy;
      const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
      const far = Math.max(innerWidth, innerHeight) * 1.4;
      packet.style.transition = 'transform .28s cubic-bezier(.4,0,1,1)';
      packet.style.transform = `translate(${d.ox + dx * far}px, ${d.oy + dy * far}px) rotate(${dx * 20}deg)`;
      state = 'gone';
      setTimeout(() => { if (state === 'gone') packet.style.display = 'none'; }, 320);
    } else {
      packet.style.transition = 'transform .35s cubic-bezier(.2,1.4,.4,1)';
      packet.style.transform = '';
    }
  }

  // ---------- toques ----------
  let tStart = null, holdTimer = null, lastTap = 0, lastTapX = 0, lastTapY = 0;
  const inResetZone = t => t.clientX < 100 && t.clientY < 130;

  document.addEventListener('touchstart', e => {
    e.preventDefault(); wake();
    const t = e.changedTouches[0];
    tStart = { x: t.clientX, y: t.clientY, time: performance.now() };
    clearTimeout(holdTimer); holdTimer = null;
    if (e.touches.length === 1 && inResetZone(t)) {
      holdTimer = setTimeout(() => { holdTimer = null; tStart = null; drag = null; startCapture(); }, 1200);
    }
    if (state === 'folded' && e.touches.length === 1) startDrag(t);
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    e.preventDefault();
    const t = e.changedTouches[0];
    if (tStart && holdTimer && Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y) > 15) { clearTimeout(holdTimer); holdTimer = null; }
    if (drag) moveDrag(t);
  }, { passive: false });

  document.addEventListener('touchend', e => {
    e.preventDefault();
    clearTimeout(holdTimer); holdTimer = null;
    if (drag) { endDrag(); tStart = null; return; }
    if (!tStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - tStart.x, dy = t.clientY - tStart.y, dt = performance.now() - tStart.time;
    const d = Math.hypot(dx, dy);
    tStart = null;
    if (d < 14 && dt < 350) onTap(t.clientX, t.clientY);
    else if (d > 40) onSwipe(dx, dy);
  }, { passive: false });

  // no computador (testes): mouse vira toque
  if (!('ontouchstart' in window)) {
    const fake = (type, e) => {
      const touch = { clientX: e.clientX, clientY: e.clientY };
      const ev = new Event(type, { cancelable: true });
      ev.changedTouches = [touch]; ev.touches = type === 'touchend' ? [] : [touch];
      document.dispatchEvent(ev);
    };
    let down = false;
    addEventListener('mousedown', e => { down = true; fake('touchstart', e); });
    addEventListener('mousemove', e => { if (down) fake('touchmove', e); });
    addEventListener('mouseup', e => { down = false; fake('touchend', e); });
  }

  function onTap(x, y) {
    if (state === 'needtap') { startCapture(); return; }
    if (state === 'ready') { enter(0, 1); return; }
    if (state === 'back' || state === 'face') {
      const now = performance.now();
      if (now - lastTap < 400 && Math.hypot(x - lastTapX, y - lastTapY) < 70) {
        lastTap = 0;
        if (state === 'back') flip(); else fold();
      } else { lastTap = now; lastTapX = x; lastTapY = y; }
    }
  }
  function onSwipe(dx, dy) {
    if (state === 'ready') enter(dx, dy);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      wake();
      if (state === 'capture' && (!stream || !stream.active)) startCapture();
    }
  });

  // ---------- modo ensaio (?ensaio): mostra o que a câmera vê ----------
  function drawDebug(det, m) {
    const c = $('dbgc'); c.width = small.width; c.height = small.height;
    const x = c.getContext('2d'); x.drawImage(small, 0, 0);
    if (det) {
      x.strokeStyle = '#0f0'; x.lineWidth = 2; x.beginPath();
      det.quad.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath(); x.stroke();
      x.fillStyle = '#f0f'; x.fillRect(det.quad[0].x - 3, det.quad[0].y - 3, 6, 6);
    }
    $('dbgt').textContent = m ? `${CARD_BY_ID[m.best.id].label} ${m.best.score.toFixed(2)} / ${CARD_BY_ID[m.second.id].label} ${m.second.score.toFixed(2)}` : 'procurando...';
  }

  // ---------- início ----------
  (async () => {
    const deck = await loadDeck();
    backImg = deck.back;
    if (deck.missing.length) console.warn('Cartas faltando:', deck.missing);
    templates = CARDS.filter(c => c.img).map(c => ({ id: c.id, feat: Engine.templateFeatures(c.img, MW, MH) }));
    backURL = backImg ? backImg.src : '';
    window.__app = { get state() { return state; }, get captured() { return capturedId; } };
    startCapture();
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
