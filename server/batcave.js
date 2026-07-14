// batcave.biz may send first navigations through a JS interstitial at /_c?t=...&u=...
// before bouncing to the requested page. Reader page images live on img.batcave.biz
// as /img/<shard>/<comicId>/<chapterId>/<page>-<server-hash>.jpg; the hash must be
// read from the reader page or its data, never constructed.
'use strict';

const BASE = 'https://batcave.biz';
const SITE_HOST = 'batcave.biz';
const IMG_HOST = 'img.batcave.biz';
const NAV_TIMEOUT_MS = 30000;
const INTERSTITIAL_TIMEOUT_MS = 25000;

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || (url.hostname !== SITE_HOST && url.hostname !== IMG_HOST)) {
    throw new Error('Blocked non-batcave URL');
  }
  return url.toString();
}

function isAllowedUrl(value) {
  try {
    safeUrl(value);
    return true;
  } catch (e) {
    return false;
  }
}

function isInterstitialUrl(value) {
  try {
    const url = new URL(value);
    return url.hostname === SITE_HOST && url.pathname === '/_c';
  } catch (e) {
    return String(value || '').indexOf('/_c?') !== -1;
  }
}

function isLoadingTitle(value) {
  return /^(loading|just a moment|checking)\b/i.test(cleanText(value));
}

async function navigate(page, url) {
  await page.goto(safeUrl(url), { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });

  const deadline = Date.now() + INTERSTITIAL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const current = page.url();
    if (current && current !== 'about:blank' && !isAllowedUrl(current)) {
      throw new Error('Blocked batcave redirect');
    }

    let title = '';
    try {
      title = await page.title();
    } catch (e) {}

    if (!isInterstitialUrl(current) && !isLoadingTitle(title)) {
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
      return;
    }

    await page.waitForTimeout(500);
  }

  throw new Error('Timed out waiting for batcave interstitial');
}

async function closePage(page) {
  if (!page) return;
  await page.close().catch(() => {});
}

function detailUrl(slug) {
  const path = String(slug || '').trim().replace(/^\/+/, '').replace(/\.html$/i, '');
  return safeUrl(`${BASE}/${path}.html`);
}

function readerUrl(comicId, chapterId) {
  return safeUrl(`${BASE}/reader/${encodeURIComponent(String(comicId))}/${encodeURIComponent(String(chapterId))}`);
}

function imageUrlsOnly(values) {
  const out = [];
  const seen = new Set();

  for (const value of values || []) {
    let url;
    const raw = String(value || '').trim();
    try {
      url = new URL(raw, raw.startsWith('/img/') ? `https://${IMG_HOST}` : BASE);
    } catch (e) {
      continue;
    }

    if (url.protocol !== 'https:' || url.hostname !== IMG_HOST || !url.pathname.startsWith('/img/')) {
      continue;
    }

    const normalized = url.toString();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }

  return out;
}

function chapterPages(value) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Parse the comic cards on any batcave list page (search, /comix/, /xfsearch).
// Self-contained — runs in the page context (browser globals only).
const LIST_PARSER = () => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const publisherNames = ['DC Comics', 'Marvel Comics', 'Image Comics'];

      const abs = (value) => {
        try {
          return new URL(value, location.href).toString();
        } catch (e) {
          return '';
        }
      };

      const comicFromHref = (href) => {
        let url;
        try {
          url = new URL(href, location.href);
        } catch (e) {
          return null;
        }
        if (url.protocol !== 'https:' || url.hostname !== 'batcave.biz') return null;
        const match = url.pathname.match(/^\/(\d+)-([^/]+)\.html$/i);
        if (!match) return null;
        return { id: match[1], slug: `${match[1]}-${match[2]}` };
      };

      const cardFor = (anchor) => {
        let node = anchor.parentElement;
        for (let i = 0; node && i < 4; i += 1, node = node.parentElement) {
          if (node.querySelector && node.querySelector('img[src*="/uploads/posts/poster/"], img[data-src*="/uploads/posts/poster/"]')) {
            return node;
          }
        }

        const card = anchor.closest('article, li, .shortstory, .short, .story, .card, .item, .th-item, .news, .movie, .poster, .entry');
        if (card) return card;
        return anchor;
      };

      const imageFrom = (card, anchor) => {
        const img = anchor.querySelector('img[src], img[data-src], img[data-original], img[data-lazy-src]') ||
          card.querySelector('img[src*="/uploads/posts/poster/"], img[data-src*="/uploads/posts/poster/"], img[src], img[data-src], img[data-original], img[data-lazy-src]');
        if (!img) return '';
        return abs(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy-src'));
      };

      const titleFrom = (card, anchor, fallbackSlug) => {
        const titled = clean(anchor.getAttribute('title') || anchor.getAttribute('aria-label'));
        if (titled) return titled;

        const img = anchor.querySelector('img[alt]') || card.querySelector('img[alt]');
        const alt = clean(img && img.getAttribute('alt'));
        if (alt) return alt;

        const titleEl = card.querySelector('h1, h2, h3, h4, .title, .name, [class*="title"], [class*="name"]');
        const title = clean((titleEl || anchor).textContent);
        if (title) return title;

        const lines = String(card.textContent || '').split(/\n+/).map(clean).filter(Boolean);
        const line = lines.find((value) => !/\b((?:19|20)\d{2})\b/.test(value) && !publisherNames.some((name) => new RegExp('\\b' + name.replace(/\s+/g, '\\s+') + '\\b', 'i').test(value)));
        return line || fallbackSlug.replace(/^\d+-/, '').replace(/-/g, ' ');
      };

      const seen = new Set();
      const results = [];

      for (const anchor of document.querySelectorAll('a[href]')) {
        const comic = comicFromHref(anchor.getAttribute('href'));
        if (!comic || seen.has(comic.slug)) continue;
        seen.add(comic.slug);

        const card = cardFor(anchor);
        const text = clean(card.textContent);
        const publisher = publisherNames.find((name) => new RegExp('\\b' + name.replace(/\s+/g, '\\s+') + '\\b', 'i').test(text));
        const yearMatch = text.match(/\b((?:19|20)\d{2})\b/);

        results.push({
          id: comic.id,
          slug: comic.slug,
          title: titleFrom(card, anchor, comic.slug),
          cover: imageFrom(card, anchor),
          publisher: publisher || undefined,
          year: yearMatch ? yearMatch[1] : undefined,
        });
      }

      return results;
};

async function parseListPage(page) {
  return await page.evaluate(LIST_PARSER);
}

async function search(query, ctx) {
  let page;
  try {
    page = await ctx.newPage();
    await navigate(page, `${BASE}/search/${encodeURIComponent(String(query || '').trim())}`);
    return await parseListPage(page);
  } catch (e) {
    return [];
  } finally {
    await closePage(page);
  }
}

// Browse the catalogue or a publisher list. publisher = "DC Comics" / "Marvel Comics"
// / "Image Comics" (DLE custom-field browse at /xfsearch/<pub>/); omitted = full /comix/.
async function browse(opts, ctx) {
  const o = opts || {};
  const pageNum = Math.max(1, parseInt(o.page, 10) || 1);
  let path;
  if (o.publisher) {
    path = `${BASE}/xfsearch/${encodeURIComponent(String(o.publisher).trim())}/`;
    if (pageNum > 1) path += `page/${pageNum}/`;
  } else {
    path = pageNum > 1 ? `${BASE}/comix/page/${pageNum}/` : `${BASE}/comix/`;
  }
  let page;
  try {
    page = await ctx.newPage();
    await navigate(page, path);
    return await parseListPage(page);
  } catch (e) {
    return [];
  } finally {
    await closePage(page);
  }
}

async function detail(slug, ctx) {
  let page;
  try {
    page = await ctx.newPage();
    await navigate(page, detailUrl(slug));

    const data = await page.evaluate(() => window.__DATA__ || null);
    const dom = await page.evaluate(() => {
      const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const publisherNames = ['DC Comics', 'Marvel Comics', 'Image Comics'];

      const abs = (value) => {
        try {
          return new URL(value, location.href).toString();
        } catch (e) {
          return '';
        }
      };

      const textOf = (selectors) => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const text = clean(el && el.textContent);
          if (text) return text;
        }
        return '';
      };

      const attrOf = (selectors, attr) => {
        for (const selector of selectors) {
          const el = document.querySelector(selector);
          const value = clean(el && el.getAttribute(attr));
          if (value) return value;
        }
        return '';
      };

      const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const metaByLabel = (labels) => {
        const nodes = document.querySelectorAll('li, p, div, span, tr');
        for (const node of nodes) {
          const text = clean(node.textContent);
          if (!text || text.length > 180) continue;
          for (const label of labels) {
            const match = text.match(new RegExp('^' + escapeRegExp(label) + '\\s*:?\\s*(.+)$', 'i'));
            if (match && clean(match[1])) return clean(match[1]);
          }
        }
        return '';
      };

      const bodyText = clean(document.body && document.body.innerText);
      const posterSelectors = ['img[src*="/uploads/posts/poster/"]', 'img[data-src*="/uploads/posts/poster/"]', 'img[src*="/uploads/posts/"]', 'img[data-src*="/uploads/posts/"]'];
      const cover = abs(attrOf(['meta[property="og:image"]'], 'content') ||
        attrOf(posterSelectors, 'src') || attrOf(posterSelectors, 'data-src'));

      const publisher = metaByLabel(['Publisher', 'Company']) ||
        publisherNames.find((name) => new RegExp('\\b' + name.replace(/\s+/g, '\\s+') + '\\b', 'i').test(bodyText)) || '';

      const yearText = metaByLabel(['Year', 'Release year', 'Released']);
      const yearMatch = (yearText || bodyText).match(/\b((?:19|20)\d{2})\b/);

      const description = textOf(['[itemprop="description"]', '.description', '.full-text', '.fullstory', '.story-text', '.news-text', '.entry-content', '.content .text']) ||
        attrOf(['meta[property="og:description"]', 'meta[name="description"]'], 'content');

      const rating = metaByLabel(['Rating', 'Score']) ||
        attrOf(['[itemprop="ratingValue"]'], 'content') ||
        textOf(['[itemprop="ratingValue"]', '.rating', '[class*="rating"]']);

      return {
        title: textOf(['h1', '.title', '[class*="title"]']) || attrOf(['meta[property="og:title"]'], 'content'),
        cover,
        publisher: clean(publisher),
        year: yearMatch ? yearMatch[1] : '',
        description: clean(description),
        rating: clean(rating),
      };
    });

    const idMatch = String(slug || '').match(/^(\d+)-/);
    const chapters = Array.isArray(data && data.chapters) ? data.chapters.map((chapter) => ({
      id: String(chapter && chapter.id != null ? chapter.id : ''),
      title: cleanText((chapter && (chapter.title || chapter.title_en)) || ''),
      pages: chapterPages(chapter && chapter.pages),
      date: cleanText(chapter && chapter.date) || undefined,
    })).filter((chapter) => chapter.id) : [];

    return {
      id: String((data && data.news_id) || (idMatch && idMatch[1]) || ''),
      title: cleanText((data && data.title) || dom.title),
      cover: dom.cover || undefined,
      publisher: dom.publisher || undefined,
      year: dom.year || undefined,
      description: dom.description || undefined,
      rating: dom.rating || undefined,
      chapters,
    };
  } catch (e) {
    throw new Error(e && e.message ? e.message : 'batcave detail failed');
  } finally {
    await closePage(page);
  }
}

async function dataImageUrls(page) {
  const values = await page.evaluate(() => {
    const data = window.__DATA__;
    if (!data) return [];

    const fromValue = (value) => {
      if (!value) return '';
      if (typeof value === 'string') return value;
      if (typeof value !== 'object') return '';
      return value.url || value.src || value.image || value.img || value.href || value.path || '';
    };

    const fromArray = (value) => Array.isArray(value) ? value.map(fromValue).filter(Boolean) : [];
    const candidates = [data.images, data.pages, data.reader && data.reader.images,
      data.reader && data.reader.pages, data.chapter && data.chapter.images, data.chapter && data.chapter.pages];

    for (const candidate of candidates) {
      const urls = fromArray(candidate);
      if (urls.some((url) => String(url).indexOf('img.batcave.biz') !== -1)) return urls;
    }

    return [];
  });

  return imageUrlsOnly(values);
}

async function scrollReader(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let lastHeight = 0;
      let stable = 0;
      const step = Math.max(window.innerHeight || 800, 800);
      const timer = setInterval(() => {
        const height = Math.max(
          document.body ? document.body.scrollHeight : 0,
          document.documentElement ? document.documentElement.scrollHeight : 0
        );

        window.scrollTo(0, Math.min(window.scrollY + step, height));

        if (height === lastHeight && window.scrollY + window.innerHeight >= height - 5) {
          stable += 1;
        } else {
          stable = 0;
        }

        lastHeight = height;
        if (stable >= 2) {
          clearInterval(timer);
          resolve();
        }
      }, 300);
    });
  });
}

async function domImageUrls(page) {
  const values = await page.evaluate(() => {
    const out = [];

    const add = (value) => {
      if (value && String(value).indexOf('img.batcave.biz') !== -1) out.push(value);
    };

    const addSrcset = (value) => {
      String(value || '').split(',').forEach((part) => add(part.trim().split(/\s+/)[0]));
    };

    document.querySelectorAll('link[rel~="preload"][as="image"][href*="img.batcave.biz"]').forEach((el) => {
      add(el.getAttribute('href'));
    });

    document.querySelectorAll('img, source').forEach((el) => {
      add(el.getAttribute('src'));
      add(el.getAttribute('data-src'));
      add(el.getAttribute('data-original'));
      add(el.getAttribute('data-lazy-src'));
      add(el.getAttribute('data-url'));
      addSrcset(el.getAttribute('srcset'));
      addSrcset(el.getAttribute('data-srcset'));
    });

    return out;
  });

  return imageUrlsOnly(values);
}

async function pages(comicId, chapterId, ctx) {
  let page;
  try {
    page = await ctx.newPage();
    await navigate(page, readerUrl(comicId, chapterId));

    const dataDeadline = Date.now() + 10000;
    while (Date.now() < dataDeadline) {
      const urls = await dataImageUrls(page);
      if (urls.length) return urls;
      await page.waitForTimeout(500);
    }

    await scrollReader(page);
    await page.waitForTimeout(1000);
    return await domImageUrls(page);
  } catch (e) {
    return [];
  } finally {
    await closePage(page);
  }
}

module.exports = { search, browse, detail, pages };
