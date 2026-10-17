// Draws the pictures that links to the site show in social networks and messengers (og:image,
// 1200×630, one per language) and the icon for the home screens of phones (180×180), into
// site/public, where Vite copies them to the site as they are. They are drawn by headless Chrome
// from HTML in the look of the home page, with its fonts. The pictures are committed, so the site
// builds without Chrome; run `npm run site:images` after changing the texts below or the logo.
// The path to Chrome is taken from $CHROME, else the usual ones are tried.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = new URL('../', import.meta.url).pathname;
const output = join(root, 'site/public');

/** The texts of a picture: those of the first screen of the home page. */
interface Texts {
  lang: string;
  title: string;
  accent: string;
  lead: string;
}

const TEXTS: Texts[] = [
  {
    lang: 'en',
    title: 'JavaScript on',
    accent: 'every core.',
    lead: 'The semantics of JavaScript, the syntax of Go, static types.',
  },
  {
    lang: 'ru',
    title: 'JavaScript на',
    accent: 'всех ядрах.',
    lead: 'Семантика JavaScript, синтаксис Go, статические типы.',
  },
];

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

function chrome(): string {
  const path = process.env.CHROME ?? CHROMES.find((candidate) => existsSync(candidate));

  if (path === undefined) throw new Error('Chrome is not found; give its path in $CHROME');

  return path;
}

const font = (name: string, file: string) =>
  pathToFileURL(join(root, 'node_modules/@fontsource-variable', name, 'files', file)).href;

const logo = `data:image/webp;base64,${readFileSync(join(root, 'site/src/rook.webp')).toString('base64')}`;

const STYLE = `
@font-face { font-family: Geist; font-weight: 100 900;
  src: url(${font('geist', 'geist-latin-wght-normal.woff2')}) format('woff2'); }
@font-face { font-family: Geist; font-weight: 100 900; unicode-range: U+0400-04FF;
  src: url(${font('geist', 'geist-cyrillic-wght-normal.woff2')}) format('woff2'); }
@font-face { font-family: Geist Mono; font-weight: 100 900;
  src: url(${font('geist-mono', 'geist-mono-latin-wght-normal.woff2')}) format('woff2'); }
* { box-sizing: border-box; margin: 0; }
html, body { width: 1200px; height: 630px; overflow: hidden; background: #000; }
body { position: relative; font-family: Geist; color: #ededed; }
.board { position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg, rgb(255 255 255 / 5%) 0 1px, transparent 1px 80px);
  mask-image: radial-gradient(ellipse 80% 90% at 70% 40%, #000 30%, transparent 80%); }
.glow { position: absolute; top: -320px; right: -200px; width: 1100px; height: 800px;
  background: radial-gradient(closest-side, rgb(245 158 42 / 22%), transparent); }
.trail { position: absolute; width: 2px; height: 180px; border-radius: 2px;
  background: linear-gradient(to bottom, transparent, rgb(245 158 42 / 70%) 75%, #ffd9a0);
  filter: drop-shadow(0 0 6px rgb(245 158 42 / 90%)); }
.content { position: absolute; inset: 72px 80px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 16px; font-size: 36px; font-weight: 600;
  letter-spacing: -0.03em; }
.brand img { width: 56px; height: 56px; }
h1 { margin-top: auto; font-size: 108px; font-weight: 700; line-height: 1.02;
  letter-spacing: -0.055em; }
h1 span { display: block; background-clip: text; color: transparent; padding-bottom: 0.06em; }
.base { background-image: linear-gradient(180deg, #fff 20%, #a8a8a8 100%); }
.accent { background-image: linear-gradient(135deg, #ffc46b 0%, #f59e2a 45%, #d9730b 100%); }
p { margin-top: 24px; color: #a1a1a1; font-size: 32px; letter-spacing: -0.01em; }
.install { position: absolute; top: 0; right: 0; padding: 12px 20px; border-radius: 10px;
  border: 1px solid rgb(255 255 255 / 14%); background: rgb(10 10 10 / 85%);
  color: #a1a1a1; font: 22px Geist Mono; }
.install b { color: #6b6b6b; font-weight: 400; margin-right: 12px; }
`;

/** The trails of light on the lines of the board, as on the home page: [line, top]. */
const TRAILS = [
  [8, 40],
  [10, 300],
  [11, 150],
  [13, 200],
  [14, 420],
];

function card(texts: Texts): string {
  const trails = TRAILS.map(
    ([line, top]) => `<div class="trail" style="left:${line! * 80}px;top:${top}px"></div>`,
  ).join('');

  return `<!doctype html><html lang="${texts.lang}"><meta charset="utf-8"><style>${STYLE}</style>
<div class="board"></div><div class="glow"></div>${trails}
<div class="content">
  <div class="brand"><img src="${logo}" alt="">Rook</div>
  <div class="install"><b>$</b>npm install rooklang</div>
  <h1><span class="base">${texts.title}</span><span class="accent">${texts.accent}</span></h1>
  <p>${texts.lead}</p>
</div></html>`;
}

const ICON = `<!doctype html><meta charset="utf-8"><style>
* { margin: 0; } html, body { width: 180px; height: 180px; overflow: hidden; }
body { display: grid; place-items: center;
  background: radial-gradient(circle at 50% 30%, #2a1a06, #000 75%); }
img { width: 132px; height: 132px; }
</style><img src="${logo}" alt="">`;

function screenshot(html: string, file: string, width: number, height: number): void {
  const dir = mkdtempSync(join(tmpdir(), 'rook-image-'));
  const page = join(dir, 'page.html');

  writeFileSync(page, html);
  try {
    execFileSync(chrome(), [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      `--screenshot=${join(output, file)}`,
      pathToFileURL(page).href,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`site/public/${file}`);
}

for (const texts of TEXTS) {
  screenshot(card(texts), `og-${texts.lang}.png`, 1200, 630);
}

screenshot(ICON, 'apple-touch-icon.png', 180, 180);
