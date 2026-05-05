// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

import node from '@astrojs/node';

// https://astro.build/config
export default defineConfig({
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
          ],
        },
        {
          label: 'App',
          items: [
            { label: 'Client', slug: 'reference/client' },
            { label: 'Server', slug: 'reference/server' },
            { label: 'Database Schema', slug: 'reference/schema' },
          ],
        },
      ],
    }),
  ],

  adapter: node({
    mode: 'standalone',
  }),

  site: "https://musubi.frgtn.dev",
  base: "/docs"
});
