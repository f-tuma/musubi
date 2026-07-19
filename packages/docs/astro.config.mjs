// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import mermaid from 'astro-mermaid';
import node from '@astrojs/node';

export default defineConfig({
  // Astro 6 leaves markdown.gfm unset in the resolved config and only the .md
  // pipeline fills the default — MDX inherits `undefined` and drops tables.
  // Explicit gfm keeps tables working in .mdx pages.
  markdown: { gfm: true, smartypants: true },

  integrations: [
    // astro-mermaid must come BEFORE starlight so its rehype step runs first.
    // Renders client-side (no build-time headless browser) and follows the
    // active light/dark theme.
    // useMaxWidth:false keeps diagrams at a legible intrinsic size instead of
    // shrinking to fit — on narrow screens the .mermaid container scrolls
    // horizontally (see custom.css) rather than rendering unreadable text.
    mermaid({
      theme: 'default',
      autoTheme: true,
      mermaidConfig: {
        flowchart: { useMaxWidth: false },
        sequence: { useMaxWidth: false },
        er: { useMaxWidth: false },
      },
    }),
    starlight({
      title: 'Musubi',
      customCss: ['./src/styles/custom.css'],
      social: [
        { icon: 'discord', label: 'Discord', href: 'https://discord.musubi.pro' },
        { icon: 'github', label: 'GitHub', href: 'https://github.com/f-tuma/musubi' },
      ],
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'guides/introduction' },
            { label: 'Home Screen Widgets', slug: 'guides/widgets' },
            { label: 'Running Locally', slug: 'guides/running-locally' },
            { label: 'Self-Hosting', slug: 'guides/self-hosting' },
          ],
        },
        {
          label: 'Architecture',
          items: [
            { label: 'Overview', slug: 'architecture/overview' },
            { label: 'Data Model', slug: 'architecture/data-model' },
            { label: 'API Server', slug: 'architecture/api' },
            { label: 'Authentication', slug: 'architecture/authentication' },
            { label: 'Client App', slug: 'architecture/client' },
            { label: 'Sync Engine', slug: 'architecture/sync' },
            { label: 'Federation', slug: 'architecture/federation' },
            { label: 'Shared Packages', slug: 'architecture/packages' },
            { label: 'Glossary', slug: 'architecture/glossary' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'Codebase Onboarding', slug: 'guides/onboarding' },
            { label: 'Contributing Guide', slug: 'guides/contributing' },
          ],
        },
      ],
    }),
  ],

  adapter: node({
    mode: 'standalone',
  }),

  base: "/docs"
});
