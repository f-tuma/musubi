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
      sidebar: [
        {
          label: 'Getting Started',
          items: [
            { label: 'Introduction', slug: 'guides/introduction' },
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
            { label: 'Client App', slug: 'architecture/client' },
            { label: 'Sync Engine', slug: 'architecture/sync' },
            { label: 'Shared Packages', slug: 'architecture/packages' },
          ],
        },
        {
          label: 'Contributing',
          items: [
            { label: 'Contributing Guide', slug: 'guides/contributing' },
            { label: 'Roadmap', slug: 'roadmap' },
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
