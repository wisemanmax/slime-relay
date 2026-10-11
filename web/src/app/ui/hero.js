// The Home hero carousel: up to six trending backdrops, rotating every 8 s.

import { IMG, kindOf, titleOf, yearOf, esc, $ } from '../util.js';

let heroItems = [], heroI = 0, heroTimer = null;

/** The titles currently in the carousel (Home's "surprise me" draws from these). */
export const heroPool = () => heroItems;

export function renderHero(items) {
  heroItems = items.filter(x => x.backdrop_path).slice(0, 6); heroI = 0;
  clearInterval(heroTimer);
  if (!heroItems.length) return '';
  heroTimer = setInterval(() => { heroI = (heroI + 1) % heroItems.length; paintHero(); }, 8000);
  return `<section class="hero" id="hero"><div class="stagewrap">
    <div class="bg" id="herobg"></div>
    <div class="inner" id="heroinner"></div></div>
    <div class="dots" id="herodots"></div></section>`;
}

export function paintHero() {
  const it = heroItems[heroI]; if (!it) return; const k = kindOf(it);
  const bg = $('herobg'); if (bg) bg.style.backgroundImage = `url(${IMG(it.backdrop_path, 'w1280')})`;
  const inner = $('heroinner');
  if (inner) inner.innerHTML = `<div class="eyebrow">FEATURED</div><h1>${esc(titleOf(it))}</h1>
    <div class="pills"><span class="pill">${yearOf(it) || ''}</span>
      <span class="pill rate">★ ${(it.vote_average || 0).toFixed(1)}</span>
      <span class="pill">${k === 'tv' ? 'Series' : 'Movie'}</span></div>
    <p class="ov">${esc(it.overview || '')}</p>
    <div class="btns">
      <button class="btn play" data-act="detail" data-id="${it.id}" data-kind="${k}">▶ Play</button>
      <button class="btn icon" title="Surprise" data-act="surprise">🎲</button>
    </div>`;
  const dots = $('herodots');
  if (dots) dots.innerHTML = heroItems.map((_, i) => `<i class="${i === heroI ? 'on' : ''}"></i>`).join('');
}
