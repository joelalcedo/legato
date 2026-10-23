// Render the README diagrams: each docs/diagrams/*.html becomes a light and a dark PNG at 2x.
// usage: node scripts/diagrams/render.mjs [name ...]      (default: every .html in docs/diagrams)
// Needs playwright-core (npm install in this folder) and a Chromium: either the one
// `npx playwright-core install chromium` fetches, or the path in $LEGATO_CHROME.
import { chromium } from 'playwright-core';
import { readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'diagrams');
const names = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.html') && (names.length === 0 || names.includes(f.replace(/\.html$/, ''))))
  .map((f) => join(dir, f));

const browser = await chromium.launch(process.env.LEGATO_CHROME ? { executablePath: process.env.LEGATO_CHROME } : {});
try {
  for (const f of files) {
    for (const theme of ['light', 'dark']) {
      // 2rem of page padding on each side leaves the SVG at its 960px viewBox width, so a PNG is 1920px wide
      const page = await browser.newPage({ viewport: { width: 1024, height: 800 }, deviceScaleFactor: 2, colorScheme: theme });
      await page.goto(pathToFileURL(f).href, { waitUntil: 'networkidle' });
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
        return document.fonts.ready;
      }, theme);
      await page.waitForTimeout(200);
      const out = f.replace(/\.html$/, `-${theme}.png`);
      await page.locator('svg').first().screenshot({ path: out });
      console.log('wrote', basename(out));
      await page.close();
    }
  }
} finally {
  await browser.close();
}
