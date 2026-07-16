import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
// Local build-time plugin: renders ```mermaid fences to inline SVG via mmdc, so
// the markdown source is preserved but no mermaid runtime ships. See the file
// header for why an off-the-shelf ESM plugin can't load in Docusaurus's config.
import remarkMermaidPrerender from './plugins/remark-mermaid-prerender.mjs';

const config: Config = {
  title: 'deckbridge',
  tagline: 'Stream Deck bridge — standalone binary, no Node',
  favicon: 'img/favicon.ico',

  future: {
    v4: true,
    faster: true,
  },

  url: 'https://lukasmega.github.io',
  baseUrl: '/DeckBridge/',

  clientModules: ['./src/analytics.ts'],

  // GitHub Pages project site: https://lukasmega.github.io/DeckBridge/
  organizationName: 'lukasMega',
  projectName: 'DeckBridge',

  onBrokenLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  markdown: {
    // Parse .md files as CommonMark (not MDX) to avoid strict JSX/brace parsing
    // on the existing docs. New .mdx files still get full MDX treatment.
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },

  // Phase 6: global injected tag (analytics stub demo)
  headTags: [
    {
      tagName: 'meta',
      attributes: { name: 'deckbridge-docs', content: 'analytics-stub-demo' },
    },
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          path: '../docs',
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
          // No editUrl — local docs, no upstream repo link needed
          beforeDefaultRemarkPlugins: [remarkMermaidPrerender],
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  // Local offline search — builds a static lunr index at build time, queried
  // in-browser. No Algolia / 3rd-party service. GitHub-Pages-safe (set baseUrl
  // correctly for the deploy target so the index path resolves).
  themes: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        // docs live at the site root (routeBasePath: '/') and on disk at
        // ../docs, so override both the route base and the source dir
        // (default 'docs') the indexer reads from
        docsRouteBasePath: '/',
        docsDir: '../docs',
        indexBlog: false,
        indexPages: false, // skip the landing + iframe pages
        language: ['en'],
        hashed: true, // content-hashed index file → long-term cache
        highlightSearchTermsOnTargetPage: true,
        searchResultLimits: 8,
        searchResultContextMaxLength: 50,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'deckbridge',
      style: 'dark',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'technicalSidebar',
          label: 'Technical Details',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          label: 'GitHub',
          href: 'https://github.com/lukasMega/DeckBridge',
        },
      ],
      copyright: `deckbridge — Stream Deck relay, no Node runtime required`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
