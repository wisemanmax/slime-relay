// Standalone extraction test: load a provider embed in headless Chromium,
// capture the .m3u8 (HLS) stream request across all frames.
const { chromium } = require('playwright');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function extract(embedUrl, { timeout = 25000 } = {}) {
  const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  const streams = [];
  const onReq = (req) => {
    const u = req.url();
    if (/\.m3u8(\?|$)/i.test(u) || /\.mp4(\?|$)/i.test(u)) {
      streams.push({ url: u, headers: req.headers() });
    }
  };
  page.on('request', onReq);
  ctx.on('request', onReq);

  try {
    await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout });
    // Give the player JS time; try clicking common play controls in all frames.
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && streams.length === 0) {
      for (const frame of page.frames()) {
        try {
          await frame.evaluate(() => {
            const v = document.querySelector('video'); if (v) { v.muted = true; v.play && v.play().catch(()=>{}); }
            const sels = ['.jw-icon-display','.vjs-big-play-button','.plyr__control--overlaid','[class*="play" i]','button'];
            for (const s of sels) { const el = document.querySelector(s); if (el) { el.click(); break; } }
          });
        } catch (e) {}
      }
      await page.waitForTimeout(1200);
    }
  } catch (e) {
    // navigation errors are ok if we already captured a stream
  }
  await browser.close();
  // Prefer m3u8 master playlists.
  streams.sort((a, b) => (/\.m3u8/i.test(b.url) - /\.m3u8/i.test(a.url)));
  return streams;
}

(async () => {
  const url = process.argv[2];
  const t0 = Date.now();
  const streams = await extract(url);
  console.log(`\n== ${url}`);
  console.log(`   took ${((Date.now()-t0)/1000).toFixed(1)}s, found ${streams.length} stream(s)`);
  streams.slice(0, 4).forEach(s => {
    console.log('   STREAM:', s.url.slice(0, 130));
    if (s.headers.referer || s.headers.origin) console.log('     referer:', s.headers.referer, '| origin:', s.headers.origin);
  });
  process.exit(0);
})();
