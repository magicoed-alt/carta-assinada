'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const video = $('cam'), card = $('card'), packet = $('packet'), home = $('home');
  const dot = $('dot'), lbl = $('lbl'), hint = $('hint');
  const DEBUG = /ensaio/.test(location.search);
  const SW = Capture.SW, SH = Capture.SH;

  // estados: load, needtap, capture, review, ready, home, entering, back, flipping, face, folding, folded, gone
  let state = 'load';
  let cap = null, backURL = '', homeURL = null;
  let stream = null, loopTimer = null, homeTimer = null;

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

  // pontinho logo abaixo da bateria (canto superior direito da barra de status)
  function placeDot() {
    const st = safeTopNow();
    const top = st >= 50 ? st - 17 : st >= 44 ? st - 12 : st + 2;
    dot.style.top = top + 'px'; dot.style.right = (innerWidth >= 420 ? 37 : 34) + 'px';
    lbl.style.top = (top + 10) + 'px'; lbl.style.right = '20px';
  }
  function safeTopNow() {
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);width:1px;visibility:hidden';
    document.body.appendChild(p); const v = p.getBoundingClientRect().height; p.remove();
    if (v >= 20) return v;
    const h = Math.max(screen.height, screen.width);
    return h >= 852 ? 59 : h >= 812 ? 47 : 20;
  }
  placeDot(); addEventListener('resize', placeDot);

  // ---------- sinais discretos ----------
  function setDot(mode, text) { dot.className = mode === 'off' ? '' : mode; lbl.textContent = text || ''; }
  function haptic() {
    try { if (navigator.vibrate) { navigator.vibrate([60, 60, 60]); return; } } catch (e) {}
    try { $('hap').click(); } catch (e) {} // iPhone (iOS 18+): vibração do "switch"
  }

  let wl = null;
  async function wake() {
    try { if ('wakeLock' in navigator && !wl) { wl = await navigator.wakeLock.request('screen'); wl.addEventListener('release', () => { wl = null; }); } } catch (e) {}
  }

  // ---------- memória do aparelho (print da Tela de Início) ----------
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('carta-assinada', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  }
  async function kvGet(k) {
    try { const db = await idb(); return await new Promise(res => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result || null); t.onerror = () => res(null); }); }
    catch (e) { return null; }
  }
  async function kvSet(k, v) {
    const db = await idb();
    return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); if (v == null) tx.objectStore('kv').delete(k); else tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  }

  function applyHome() {
    if (homeURL) { home.classList.remove('nohome'); home.style.backgroundImage = `url(${homeURL})`; }
    else { home.classList.add('nohome'); home.style.backgroundImage = ''; }
  }

  // O iPhone desenha a barra de status (hora, bateria) por cima do app; a do print é apagada para não duplicar.
  function safeTop() {
    const p = document.createElement('div');
    p.style.cssText = 'position:fixed;top:0;height:env(safe-area-inset-top,0px);width:1px;visibility:hidden';
    document.body.appendChild(p); const v = p.getBoundingClientRect().height; p.remove();
    if (v >= 20) return v;
    const h = Math.max(screen.height, screen.width);
    return h >= 852 ? 59 : h >= 812 ? 47 : 20;
  }
  async function processHomeFile(file) {
    const url = URL.createObjectURL(file);
    const im = await loadImage(url);
    const W = im.naturalWidth, H = im.naturalHeight;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d'); x.drawImage(im, 0, 0);
    URL.revokeObjectURL(url);
    const band = Math.min(H - 1, Math.round(safeTop() * W / Math.min(screen.width, screen.height)) + Math.round(W * 0.004));
    if (band > 2 && band * 2 < H) {
      // espelha a faixa logo abaixo da barra e desfoca
      const src = x.getImageData(0, band, W, band).data, out = x.createImageData(W, band);
      for (let y = 0; y < band; y++) {
        const sy = band - 1 - y;
        for (let xx = 0; xx < W; xx++) { const o = (y * W + xx) * 4, s = (sy * W + xx) * 4; out.data[o] = src[s]; out.data[o + 1] = src[s + 1]; out.data[o + 2] = src[s + 2]; out.data[o + 3] = 255; }
      }
      const r = Math.max(4, Math.round(W * 0.01)), d = out.data, tmp = new Float32Array(W * 3);
      for (let pass = 0; pass < 2; pass++) for (let y = 0; y < band; y++) {
        for (let xx = 0; xx < W; xx++) { let a = 0, b = 0, g = 0, k = 0; for (let t = -r; t <= r; t++) { const q = Math.min(W - 1, Math.max(0, xx + t)); const o = (y * W + q) * 4; a += d[o]; g += d[o + 1]; b += d[o + 2]; k++; } tmp[xx * 3] = a / k; tmp[xx * 3 + 1] = g / k; tmp[xx * 3 + 2] = b / k; }
        for (let xx = 0; xx < W; xx++) { const o = (y * W + xx) * 4; d[o] = tmp[xx * 3]; d[o + 1] = tmp[xx * 3 + 1]; d[o + 2] = tmp[xx * 3 + 2]; }
      }
      x.putImageData(out, 0, 0);
    }
    return c.toDataURL('image/jpeg', 0.92);
  }

  // ---------- ajustes ----------
  function openCfg() {
    state = 'cfg'; stopCamera();
    $('cfgimg').src = homeURL || ''; $('cfgimg').style.display = homeURL ? 'block' : 'none';
    $('cfg').style.display = 'block';
  }
  $('cfgfile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { homeURL = await processHomeFile(f); await kvSet('home', homeURL); applyHome(); $('cfgimg').src = homeURL; $('cfgimg').style.display = 'block'; }
    catch (err) { alert('Não consegui abrir essa imagem.'); }
    e.target.value = '';
  });
  $('cfgdel').addEventListener('click', async () => { homeURL = null; await kvSet('home', null); applyHome(); $('cfgimg').style.display = 'none'; });
  $('cfgclose').addEventListener('click', () => { $('cfg').style.display = 'none'; startCapture(); });

  // ---------- câmera ----------
  function stopCamera() {
    clearTimeout(loopTimer);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    video.srcObject = null;
  }

  async function startCapture() {
    clearTimeout(homeTimer);
    resetVisual();
    home.classList.add('on'); // o app fica na Tela de Início enquanto lê a carta
    $('rev').style.display = 'none';
    stopCamera();
    cap.reset();
    setDot('off');
    hint.textContent = '';
    state = 'capture';
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'user' }, width: { ideal: 1920 }, height: { ideal: 1080 } } // câmera da frente
      });
      video.srcObject = stream;
      await video.play();
      if (DEBUG) $('dbg').style.display = 'block';
      loop();
    } catch (e) {
      console.error(e);
      state = 'needtap';
      hint.textContent = 'toque para ativar a câmera' + (DEBUG ? ' (' + (e && e.name || e) + ')' : '');
    }
  }

  let lastStepMs = 0, noFrameSince = 0, lastErr = '';
  function loop() {
    if (state !== 'capture') return;
    let res = null;
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (vw && vh) {
        noFrameSince = 0;
        const t0 = performance.now();
        res = cap.step(video, vw, vh);
        lastStepMs = performance.now() - t0;
      } else {
        if (!noFrameSince) noFrameSince = performance.now();
        else if (performance.now() - noFrameSince > 4000) hint.textContent = 'câmera sem imagem — segure o canto superior esquerdo para tentar de novo';
      }
    } catch (e) { console.error(e); lastErr = String(e && e.message || e); }
    const I = cap.info;
    if (DEBUG) drawDebug();
    if (res) { finishCapture(res); return; }
    setDot(I.phase === 'none' ? 'off' : 'seek', DEBUG && I.label ? I.label : '');
    loopTimer = setTimeout(loop, 40);
  }

  async function finishCapture(res) {
    state = 'processing';
    stopCamera();
    $('dbg').style.display = 'none';
    const c = CARD_BY_ID[res.id];
    const faceURL = await composeFace(c, res.sig);
    await prepareCard(faceURL);
    hint.textContent = '';
    // câmera já desligada (travada): fica pronto para a carta aparecer
    setDot(res.quality === 'ok' ? 'ok' : 'part', DEBUG ? c.label : '');
    haptic();
    if (DEBUG) { showReview(res, faceURL); return; }
    state = 'ready';
  }

  // ---------- face: carta limpa + assinatura ----------
  function composeFace(c, sig) {
    const S = 2; // resolução dobrada: traço mais nítido
    const W = (c.img.naturalWidth || 537) * S, H = (c.img.naturalHeight || 750) * S;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const x = cv.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(c.img, 0, 0, W, H);
    if (sig.count > 0) {
      const sc = document.createElement('canvas'); sc.width = sig.W; sc.height = sig.H;
      const sx = sc.getContext('2d'); const id = sx.createImageData(sig.W, sig.H);
      const [r, g, b] = sig.color;
      for (let i = 0, j = 0; i < sig.W * sig.H; i++, j += 4) { id.data[j] = r; id.data[j + 1] = g; id.data[j + 2] = b; id.data[j + 3] = sig.alpha[i]; }
      sx.putImageData(id, 0, 0);
      const cr = Engine.cardRect(c.img);
      x.globalCompositeOperation = 'source-atop'; // só dentro da carta (cantos arredondados)
      x.drawImage(sc, cr.x * S, cr.y * S, cr.w * S, cr.h * S);
      x.globalCompositeOperation = 'source-over';
    }
    return new Promise(res => cv.toBlob(b => res(URL.createObjectURL(b)), 'image/png'));
  }

  let lastFaceURL = null;
  async function prepareCard(faceURL) {
    if (lastFaceURL) URL.revokeObjectURL(lastFaceURL);
    lastFaceURL = faceURL;
    try { await loadImage(faceURL); } catch (e) {}
    const X = 'calc(var(--cw) / -2)', Y = 'calc(var(--ch) / -2)';
    const pos = [['0px 0px', X + ' 0px'], ['0px ' + Y, X + ' ' + Y]];
    const bpos = [[X + ' 0px', '0px 0px'], [X + ' ' + Y, '0px ' + Y]];
    card.querySelectorAll('.half').forEach((h, row) => {
      h.querySelectorAll('.q').forEach((q, col) => {
        const f = q.querySelector('.f'), b = q.querySelector('.b');
        f.style.backgroundImage = `url(${faceURL})`; f.style.backgroundPosition = pos[row][col];
        b.style.backgroundImage = `url(${backURL})`; b.style.backgroundPosition = bpos[row][col];
        f.style.borderRadius = b.style.borderRadius = '0';
        const v = row ? 'Bottom' : 'Top';
        f.style['border' + v + (col ? 'Right' : 'Left') + 'Radius'] = 'var(--r)';
        b.style['border' + v + (col ? 'Left' : 'Right') + 'Radius'] = 'var(--r)';
      });
    });
    packet.style.backgroundImage = `url(${backURL})`;
  }

  // ---------- apresentação ----------
  function resetVisual() {
    card.classList.add('notrans');
    card.classList.remove('face', 'fb1', 'fb2');
    card.style.transition = 'none'; card.style.transform = ''; card.style.display = 'none';
    packet.style.display = 'none'; packet.style.transition = 'none'; packet.style.transform = '';
    void card.offsetWidth;
    card.classList.remove('notrans');
  }

  // 1 toque: a carta entra pela direita
  function enter() {
    clearTimeout(homeTimer);
    setDot('off');
    home.classList.add('on');
    state = 'entering';
    const { cw } = layout();
    card.classList.add('notrans');
    card.classList.remove('face', 'fb1', 'fb2');
    card.style.display = 'block';
    card.style.transition = 'none';
    card.style.transform = `translate(${innerWidth / 2 + cw}px, -30px) rotate(14deg)`;
    void card.offsetWidth;
    card.classList.remove('notrans');
    card.style.transition = 'transform .9s cubic-bezier(.12,.8,.25,1)';
    card.style.transform = 'translate(0,0) rotate(0deg)';
    setTimeout(() => { if (state === 'entering') state = 'back'; }, 900);
  }

  // 2 toques: vira de frente
  function flipToFace() {
    state = 'flipping';
    card.classList.add('face');
    setTimeout(() => { if (state === 'flipping') state = 'face'; }, 850);
  }

  // 2 toques de novo: vira de costas e dobra em 4 (de costas)
  function flipBackAndFold() {
    state = 'folding';
    card.classList.remove('face');
    setTimeout(() => { if (state === 'folding') card.classList.add('fb1'); }, 850);
    setTimeout(() => { if (state === 'folding') card.classList.add('fb2'); }, 1450);
    setTimeout(() => {
      if (state !== 'folding') return;
      const r = card.getBoundingClientRect();
      Object.assign(packet.style, {
        left: (r.left + r.width / 2) + 'px', top: r.top + 'px', width: r.width / 2 + 'px', height: r.height / 2 + 'px',
        transition: 'none', transform: '', display: 'block'
      });
      card.style.display = 'none';
      state = 'folded';
    }, 2080);
  }

  // ---------- arrastar o pacotinho para fora da tela ----------
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
  let tStart = null, holdTimer = null, cfgTimer = null, lastTap = 0, lastTapX = 0, lastTapY = 0, singleTimer = null;
  const inResetZone = t => t.clientX < 100 && t.clientY < 130;
  const inCfgZone = t => t.clientX > innerWidth - 100 && t.clientY < 130;
  const inPanel = e => e.target && e.target.closest && e.target.closest('#cfg');

  document.addEventListener('touchstart', e => {
    if (inPanel(e)) return;
    e.preventDefault(); wake();
    const t = e.changedTouches[0];
    tStart = { x: t.clientX, y: t.clientY, time: performance.now() };
    clearTimeout(holdTimer); holdTimer = null; clearTimeout(cfgTimer); cfgTimer = null;
    if (e.touches.length === 1 && inResetZone(t)) {
      holdTimer = setTimeout(() => { holdTimer = null; tStart = null; drag = null; startCapture(); }, 1200);
    }
    if (e.touches.length === 1 && inCfgZone(t) && (state === 'capture' || state === 'needtap')) {
      cfgTimer = setTimeout(() => { cfgTimer = null; tStart = null; openCfg(); }, 1500);
    }
    if (state === 'folded' && e.touches.length === 1) startDrag(t);
  }, { passive: false });

  document.addEventListener('touchmove', e => {
    if (inPanel(e)) return;
    e.preventDefault();
    const t = e.changedTouches[0];
    if (tStart && Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y) > 15) { clearTimeout(holdTimer); holdTimer = null; clearTimeout(cfgTimer); cfgTimer = null; }
    if (drag) moveDrag(t);
  }, { passive: false });

  document.addEventListener('touchend', e => {
    if (inPanel(e)) return;
    e.preventDefault();
    const hadHold = !!holdTimer, hadCfg = !!cfgTimer;
    clearTimeout(holdTimer); holdTimer = null; clearTimeout(cfgTimer); cfgTimer = null;
    if (drag) { endDrag(); tStart = null; return; }
    if (!tStart) return;
    const t = e.changedTouches[0];
    const d = Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y), dt = performance.now() - tStart.time;
    tStart = null;
    // toque longo, mesmo se o cronômetro atrasou (o processamento da câmera ocupa o aparelho)
    if (hadCfg && d < 15 && dt >= 1400) { openCfg(); return; }
    if (hadHold && d < 15 && dt >= 1100) { startCapture(); return; }
    if (d < 20 && dt < 400) onTap(t.clientX, t.clientY);
  }, { passive: false });

  // no computador (testes): mouse vira toque
  if (!('ontouchstart' in window)) {
    const fake = (type, e) => {
      if (e.target && e.target.closest && e.target.closest('#cfg')) return;
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
    if (state === 'review') { $('rev').style.display = 'none'; state = 'ready'; return; }
    if (state === 'ready') { enter(); return; }
    if (state === 'back' || state === 'face') {
      const now = performance.now();
      if (now - lastTap < 400 && Math.hypot(x - lastTapX, y - lastTapY) < 80) {
        lastTap = 0;
        if (state === 'back') flipToFace(); else flipBackAndFold();
      } else { lastTap = now; lastTapX = x; lastTapY = y; }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      wake();
      if (state === 'capture' && (!stream || !stream.active)) startCapture();
    }
  });

  // ---------- modo ensaio (?ensaio) ----------
  function drawDebug() {
    const I = cap.info; if (!I.small) return;
    const c = $('dbgc'); c.width = I.small.width; c.height = I.small.height;
    const x = c.getContext('2d'); x.drawImage(I.small, 0, 0);
    if (I.det) {
      x.strokeStyle = '#0f0'; x.lineWidth = 2; x.beginPath();
      I.det.quad.forEach((p, i) => i ? x.lineTo(p.x, p.y) : x.moveTo(p.x, p.y)); x.closePath(); x.stroke();
    }
    const m = I.match;
    let t = m ? `${CARD_BY_ID[m.best.id].label} ${m.best.score.toFixed(2)} / ${CARD_BY_ID[m.second.id].label} ${m.second.score.toFixed(2)}` : 'procurando carta...';
    if (I.phase === 'reading') t += `\nlendo assinatura ${I.frames}/6  larg ${I.width}px` + (I.agree ? `  concord ${I.agree.toFixed(2)}` : '') + (I.reason ? `\n${I.reason}` : '');
    t += `\ncâmera ${video.videoWidth}x${video.videoHeight}  ${Math.round(lastStepMs)} ms/quadro` + (lastErr ? `\nERRO: ${lastErr}` : '');
    $('dbgt').textContent = t; $('dbgt').style.whiteSpace = 'pre';
  }
  function showReview(res, faceURL) {
    state = 'review';
    const a = res.avg, cv = document.createElement('canvas'); cv.width = SW; cv.height = SH;
    const x = cv.getContext('2d'), d = x.createImageData(SW, SH);
    let mx = 1; for (let i = 0; i < a.length; i++) if (a[i] > mx) mx = a[i];
    for (let i = 0; i < SW * SH; i++) { for (let k = 0; k < 3; k++) d.data[i * 4 + k] = a[i * 3 + k] * 255 / mx; d.data[i * 4 + 3] = 255; }
    x.putImageData(d, 0, 0);
    $('revcap').src = cv.toDataURL('image/jpeg', 0.85);
    $('revface').src = faceURL;
    $('revt').textContent = `carta ${CARD_BY_ID[res.id].label}\nconcordância ${res.agree.toFixed(2)}  área escondida ${(res.hidden * 100).toFixed(0)}%  ${res.quality === 'ok' ? 'VERDE' : 'AMARELO (parte escondida pelo desenho)'}\n\nesquerda: foto (média)   direita: resultado\ntoque para continuar`;
    $('rev').style.display = 'block';
  }

  // ---------- início ----------
  (async () => {
    const deck = await loadDeck();
    if (deck.missing.length) console.warn('Cartas faltando:', deck.missing);
    const templates = CARDS.filter(c => c.img).map(c => ({ id: c.id, feat: Engine.templateFeatures(c.img, 60, 84) }));
    cap = Capture.create(templates, CARD_BY_ID);
    backURL = deck.back ? deck.back.src : '';
    homeURL = await kvGet('home');
    applyHome();
    window.__app = { get state() { return state; }, get info() { return cap.info; }, setHome: async u => { homeURL = u; await kvSet('home', u); applyHome(); } };
    startCapture();
  })();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
})();
