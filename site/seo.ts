import { readFileSync } from 'node:fs';
import type { HtmlTagDescriptor, Plugin } from 'vite';

// What search engines and social networks read from the site. The pages are drawn by their
// scripts, so the HTML of a page has only its <title> and description; this plugin adds to each
// page the tags made from them and from its place on the site: the canonical address, the
// addresses of the page in the other language (hreflang), Open Graph and Twitter cards with the
// picture of the language (site/public/og-<language>.png, drawn by scripts/og-image.ts), and on
// the home page JSON-LD with the name of the site. Into the built site it also writes sitemap.xml,
// with the languages of each page, and robots.txt. Addresses in these tags must be absolute: they
// start with the "homepage" of package.json.

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  homepage: string;
  description: string;
  repository: { url: string };
};

/** The address of the site, with a trailing slash. */
export const SITE = pkg.homepage.endsWith('/') ? pkg.homepage : `${pkg.homepage}/`;

/** The languages of the site; the first is at its root and the default. */
export const LANGUAGES = ['en', 'ru'];

const LOCALES: Record<string, string> = { en: 'en_US', ru: 'ru_RU' };

/** The alternative text of the picture of each language. */
const IMAGE_ALT: Record<string, string> = {
  en: 'Rook: JavaScript on every core',
  ru: 'Rook: JavaScript на всех ядрах',
};

/** A page of the site: its language and its folder from the root of the language ('' or 'docs'). */
export interface Page {
  language: string;
  page: string;
}

/** The path of a page from the root of the site: '', 'docs/', 'ru/', 'ru/docs/'. */
export function pagePath({ language, page }: Page): string {
  const root = language === LANGUAGES[0] ? '' : `${language}/`;

  return page === '' ? root : `${root}${page}/`;
}

/** The page of an index.html by its path from the root of the site, e.g. 'ru/docs/index.html'. */
export function pageOf(path: string): Page {
  const folders = path.split('/').slice(0, -1);
  const language = LANGUAGES.includes(folders[0]!) ? folders.shift()! : LANGUAGES[0]!;

  return { language, page: folders.join('/') };
}

const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };

/** Text from the HTML, with its entities decoded: Vite escapes the attributes it writes. */
const text = (html: string, pattern: RegExp, what: string, page: Page): string => {
  const value = pattern
    .exec(html)?.[1]
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/&(\w+);/g, (entity, name: string) => ENTITIES[name] ?? entity);

  if (!value) throw new Error(`site/${pagePath(page)}index.html has no ${what}`);

  return value;
};

const meta = (key: 'name' | 'property', name: string, content: string): HtmlTagDescriptor => ({
  tag: 'meta',
  attrs: { [key]: name, content },
  injectTo: 'head',
});

const link = (attrs: Record<string, string>): HtmlTagDescriptor => ({
  tag: 'link',
  attrs,
  injectTo: 'head',
});

/** The tags of a page from its HTML. */
export function headTags(html: string, page: Page): HtmlTagDescriptor[] {
  const title = text(html, /<title>([^<]+)<\/title>/, '<title>', page);
  const description = text(
    html,
    /<meta\s+name="description"\s+content="([^"]+)"/,
    'description',
    page,
  );
  const url = SITE + pagePath(page);
  const image = `${SITE}og-${page.language}.png`;
  // Files of site/public, relative like the other assets: the site works from any folder.
  const up = '../'.repeat(pagePath(page).split('/').length - 1) || './';

  return [
    link({ rel: 'canonical', href: url }),
    ...LANGUAGES.map((language) =>
      link({ rel: 'alternate', hreflang: language, href: SITE + pagePath({ ...page, language }) }),
    ),
    link({
      rel: 'alternate',
      hreflang: 'x-default',
      href: SITE + pagePath({ ...page, language: LANGUAGES[0]! }),
    }),
    link({ rel: 'apple-touch-icon', href: `${up}apple-touch-icon.png` }),
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', 'Rook'),
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    meta('property', 'og:url', url),
    meta('property', 'og:locale', LOCALES[page.language]!),
    ...LANGUAGES.filter((language) => language !== page.language).map((language) =>
      meta('property', 'og:locale:alternate', LOCALES[language]!),
    ),
    meta('property', 'og:image', image),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', '1200'),
    meta('property', 'og:image:height', '630'),
    meta('property', 'og:image:alt', IMAGE_ALT[page.language]!),
    meta('name', 'twitter:card', 'summary_large_image'),
    ...(page.page === '' ? [structuredData(page, description)] : []),
  ];
}

/** JSON-LD of a home page: the name of the site for search results, and what Rook is. */
function structuredData(page: Page, description: string): HtmlTagDescriptor {
  const url = SITE + pagePath(page);
  const repository = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  const data = {
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebSite', name: 'Rook', url, inLanguage: page.language },
      {
        '@type': 'SoftwareApplication',
        name: 'Rook',
        description,
        url,
        applicationCategory: 'DeveloperApplication',
        operatingSystem: 'Node.js 24, browsers',
        license: 'https://opensource.org/licenses/MIT',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        sameAs: [repository, 'https://www.npmjs.com/package/rooklang'],
      },
    ],
  };

  return {
    tag: 'script',
    attrs: { type: 'application/ld+json' },
    injectTo: 'head',
    // `<` cannot end the script early.
    children: JSON.stringify(data).replace(/</g, '\\u003c'),
  };
}

/** sitemap.xml: each page with its addresses in every language. */
export function sitemap(pages: string[]): string {
  const entries = pages.flatMap((page) =>
    LANGUAGES.map((language) => {
      const alternates = LANGUAGES.map(
        (other) =>
          `    <xhtml:link rel="alternate" hreflang="${other}" href="${SITE}${pagePath({ language: other, page })}"/>`,
      );

      return [
        '  <url>',
        `    <loc>${SITE}${pagePath({ language, page })}</loc>`,
        ...alternates,
        '  </url>',
      ].join('\n');
    }),
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}

/**
 * robots.txt. Crawlers read it only at the root of a host, so on GitHub Pages, where the site is
 * in a folder, it does nothing, and the sitemap is given to search engines by hand; it serves when
 * the site is at the root of a host, as with site/server.rk or a domain of its own.
 */
export const ROBOTS = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}sitemap.xml\n`;

/** The plugin; `root` is the folder of the site, `pages` the folders of the pages of a language. */
export function seo(root: string, pages: string[]): Plugin {
  return {
    name: 'rooklang-seo',
    transformIndexHtml(html, context) {
      const path = context.filename.startsWith(root)
        ? context.filename.slice(root.length).replace(/^\//, '')
        : context.path.replace(/^\//, '');

      return headTags(html, pageOf(path));
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap(pages) });
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: ROBOTS });
    },
  };
}
