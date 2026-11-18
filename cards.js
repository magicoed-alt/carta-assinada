'use strict';
/* As 52 cartas (baralho Bicycle do Eduardo), embutidas em cartas-data.js */
const RANKS = ['a', '2', '3', '4', '5', '6', '7', '8', '9', 'x', 'j', 'q', 'k'];
const RANK_LABEL = { a: 'A', x: '10', j: 'J', q: 'Q', k: 'K' };
const SUITS = [
  { k: 's', g: '♠' }, { k: 'h', g: '♥' }, { k: 'd', g: '♦' }, { k: 'c', g: '♣' }
];
const CARDS = [];
for (const s of SUITS) for (const r of RANKS) {
  CARDS.push({ id: r + s.k, label: (RANK_LABEL[r] || r) + s.g + '︎', img: null });
}
const CARD_BY_ID = Object.fromEntries(CARDS.map(c => [c.id, c]));

function loadImage(src) {
  return new Promise((res, rej) => {
    const im = new Image();
    im.onload = () => (im.decode ? im.decode().then(() => res(im), () => res(im)) : res(im));
    im.onerror = rej;
    im.src = src;
  });
}

async function loadDeck() {
  const data = window.CARTAS || {};
  let missing = [];
  await Promise.all(CARDS.map(async c => {
    try { c.img = await loadImage(data[c.id] || ('cartas/' + c.id + '.png')); }
    catch (e) { missing.push(c.id); }
  }));
  let back = null;
  try { back = await loadImage(data.back || 'cartas/back.png'); } catch (e) { missing.push('back'); }
  return { back, missing };
}
