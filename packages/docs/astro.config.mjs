// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import node from '@astrojs/node';

export default defineConfig({
  // Astro 6 leaves markdown.gfm unset in the resolved config and only the .md
  // pipeline fills the default — MDX inherits `undefined` and drops tables.
  // Explicit gfm keeps tables working in .mdx pages.
  markdown: { gfm: true, smartypants: true },

  integrations: [
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
            { label: 'Contributing', slug: 'guides/contributing' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Client', slug: 'reference/client' },
            { label: 'Server & API', slug: 'reference/server' },
            { label: 'Sync & Provider Adapters', slug: 'reference/sync' },
            { label: 'Database Schema', slug: 'reference/schema' },
          ],
        },
        {
          label: 'Roadmap',
          items: [
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
