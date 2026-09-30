// Pixel parity of CCRS's signed-in dashboard: the CCRS deployment itself
// (REF) against the same UI with its analytics served by lenspack (CAND,
// examples/ccrs/server.ts).
//
//   PROFILE=./profile REF=https://ccrs.example.org CAND=http://127.0.0.1:8795 \
//     node examples/ccrs/pixel-parity.mjs            # add SELF=1 to compare REF with itself
//
// PROFILE is a Chrome profile already signed in to both origins as the same
// user (sign in once with `npx playwright open` or a headed run). This script
// never handles a password.
//
// A screenshot comparison is only worth something if the reference matches
// itself. Each rule below removes a way CCRS's page draws differently from
// one load to the next, applied identically to both sides; SELF=1 checks that
// the result is 0 px before any lenspack comparison is believed.
import { writeFileSync } from "node:fs";

import pixelmatch from "pixelmatch";
import { chromium } from "playwright";
import { PNG } from "pngjs";

const REF = process.env.REF;
const CAND = process.env.SELF ? REF : process.env.CAND;
const PROFILE = process.env.PROFILE;
if (!REF || !CAND || !PROFILE) throw new Error("REF, CAND (or SELF=1) and PROFILE are required");
const W = Number(process.env.W ?? 1456);
// Taller than the page: a full-page screenshot resizes the viewport while it
// shoots, and CCRS's grid re-lays itself out when it does.
const H = Number(process.env.H ?? 1800);
const OUT = process.env.OUT ?? "parity";

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chrome",
  headless: true,
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  // The same DOM rasterises to the same pixels.
  args: ["--disable-gpu", "--disable-lcd-text", "--force-color-profile=srgb", "--font-render-hinting=none", "--disable-partial-raster", "--disable-skia-runtime-opts", "--disable-font-subpixel-positioning"],
});

// Cards are placed with CSS transforms and animated in; a card that happens to
// hold its own compositor layer draws its fractionally positioned text
// differently. No transitions, no layer hints — layout and content untouched.
await ctx.addInitScript(() => {
  const css = "*,*::before,*::after{transition:none!important;animation:none!important;will-change:auto!important}";
  const add = () => {
    const st = document.createElement("style");
    st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
  };
  if (document.documentElement) add();
  else document.addEventListener("DOMContentLoaded", add);
});

// Saved layout and filter preferences differ per origin: each side shows the pack's defaults.
const PREFS = "^ccrs\\.|dashboard-chart-baseline|dashboard-filters|catalog-layout|hier-level";

async function open(base, side) {
  const page = await ctx.newPage();
  const analytics = [];
  page.on("response", async (r) => {
    if (!/\/(api\/analytics|pgr-services\/v2\/analytics)\//.test(r.url()) || r.request().method() !== "POST") return;
    try {
      analytics.push({ body: await r.json(), servedBy: r.headers()["x-served-by"] ?? "ccrs" });
    } catch {}
  });
  const url = `${base}/digit-ui/employee/dashboard`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const user = await page.evaluate((re) => {
    for (const key of Object.keys(localStorage)) if (new RegExp(re, "i").test(key)) localStorage.removeItem(key);
    try {
      const v = JSON.parse(localStorage.getItem("Employee.user-info") ?? "null");
      return (v?.value ?? v)?.userName ?? null;
    } catch {
      return null;
    }
  }, PREFS);
  analytics.length = 0;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForFunction(() => [...document.querySelectorAll("img.leaflet-tile")].every((i) => i.complete && i.classList.contains("leaflet-tile-loaded")), null, { timeout: 20000 }).catch(() => {});
  return { side, page, analytics, user };
}

// A page is shot once it is still: two frames 1.5 s apart, identical — past
// chart animations and the dashboard's own periodic refresh. The content area
// is wider than the space beside the sidebar and sometimes scrolls itself
// sideways, so every frame is shot from scroll origin.
async function still(p) {
  let last = null;
  for (let i = 0; i < 12; i++) {
    await p.page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const el of document.querySelectorAll("*")) if (el.scrollLeft || el.scrollTop) {
        el.scrollLeft = 0;
        el.scrollTop = 0;
      }
    });
    const buf = await p.page.screenshot();
    if (last && buf.equals(last)) return PNG.sync.read(buf);
    last = buf;
    await p.page.waitForTimeout(1500);
  }
  return PNG.sync.read(last);
}

const lastAsOf = (p) => p.analytics.map((x) => x.body?.asOf).filter((v) => v !== undefined).at(-1);

let result;
for (let attempt = 1; attempt <= 3; attempt++) {
  const [ref, cand] = await Promise.all([open(REF, "ref"), open(CAND, "cand")]);
  if (!ref.user || ref.user !== cand.user) throw new Error(`sign in to both origins as the same user in ${PROFILE} (found ${ref.user} / ${cand.user})`);
  await Promise.all([ref.page.waitForTimeout(4000), cand.page.waitForTimeout(4000)]);
  // "Updated N min ago" is relative to the viewer's clock: both inside one minute.
  let shots;
  for (let t = 0; t < 3; t++) {
    const minute = Math.floor(Date.now() / 60_000);
    shots = await Promise.all([still(ref), still(cand)]);
    if (Math.floor(Date.now() / 60_000) === minute) break;
  }
  // The analytics tables are rebuilt every few minutes; a rebuild between the
  // two loads is two snapshots, not a difference. Such a pair is redone.
  const sameSnapshot = lastAsOf(ref) === lastAsOf(cand);
  const [a, b] = shots;
  const diff = new PNG({ width: a.width, height: a.height });
  const pixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  result = { user: ref.user, attempt, sameSnapshot, diffPixels: pixels, pct: +((100 * pixels) / (a.width * a.height)).toFixed(3), candServedBy: [...new Set(cand.analytics.map((x) => x.servedBy))] };
  writeFileSync(`${OUT}-ref.png`, PNG.sync.write(a));
  writeFileSync(`${OUT}-cand.png`, PNG.sync.write(b));
  writeFileSync(`${OUT}-diff.png`, PNG.sync.write(diff));
  await Promise.all([ref.page.close(), cand.page.close()]);
  if (sameSnapshot) break;
}
console.log(JSON.stringify(result));
await ctx.close();
process.exit(result.diffPixels === 0 ? 0 : 1);
