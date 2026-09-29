import { chromium } from 'playwright';
import { execSync } from 'node:child_process';

const out = process.argv[2] ?? 'screenshots';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
for (const scheme of ['light', 'dark']) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, colorScheme: scheme, deviceScaleFactor: 2 });
  await page.goto('http://localhost:4000/');
  await page.waitForSelector('#rows tr');
  if (scheme === 'light') {
    await page.screenshot({ path: `${out}/1-race.png`, fullPage: true });
    execSync('npx tsx dev/demo.ts reopen');
    await page.click('#refresh');
    await page.waitForSelector('.tag.reopened');
    await page.waitForTimeout(300);
  }
  await page.screenshot({ path: `${out}/${scheme === 'light' ? '2-after-refresh' : '3-dark'}.png`, fullPage: true });
  await page.close();
}
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
await m.goto('http://localhost:4000/');
await m.waitForSelector('#rows tr');
await m.screenshot({ path: `${out}/4-mobile.png`, fullPage: true });
await browser.close();
