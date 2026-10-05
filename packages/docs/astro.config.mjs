// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import mermaid from "astro-mermaid";
import node from "@astrojs/node";

export default defineConfig({
	site: "https://musubi.pro",
	base: "/docs",
	server: {
		headers: {
			"Content-Security-Policy": "frame-ancestors 'none'",
			"Referrer-Policy": "no-referrer",
			"X-Content-Type-Options": "nosniff",
			"X-Frame-Options": "DENY",
		},
	},

	integrations: [
		// astro-mermaid must come BEFORE starlight so its rehype step runs first.
		// Renders client-side (no build-time headless browser) and follows the
		// active light/dark theme.
		// useMaxWidth:false keeps diagrams at a legible intrinsic size instead of
		// shrinking to fit — on narrow screens the .mermaid container scrolls
		// horizontally (see custom.css) rather than rendering unreadable text.
		mermaid({
			theme: "default",
			autoTheme: true,
			mermaidConfig: {
				flowchart: { useMaxWidth: false },
				sequence: { useMaxWidth: false },
				er: { useMaxWidth: false },
			},
		}),
		starlight({
			title: "Musubi",
			description:
				"Learn Musubi’s architecture, run it locally, contribute safely, and operate your own server.",
			customCss: ["./src/styles/custom.css"],
			editLink: {
				baseUrl:
					"https://github.com/f-tuma/musubi/edit/main/packages/docs/",
			},
			lastUpdated: true,
			social: [
				{
					icon: "discord",
					label: "Discord",
					href: "https://discord.musubi.pro",
				},
				{
					icon: "github",
					label: "GitHub",
					href: "https://github.com/f-tuma/musubi",
				},
			],
			sidebar: [
				{
					label: "Start Here",
					items: [
						{ label: "Introduction", slug: "guides/introduction" },
						{ label: "Shared Tasks", slug: "guides/shared-tasks" },
						{ label: "Run Locally", slug: "guides/running-locally" },
						{ label: "Codebase Onboarding", slug: "guides/onboarding" },
						{ label: "Troubleshooting", slug: "guides/troubleshooting" },
					],
				},
				{
					label: "Architecture",
					items: [
						{ label: "Overview", slug: "architecture/overview" },
						{ label: "Data Model", slug: "architecture/data-model" },
						{ label: "API Server", slug: "architecture/api" },
						{ label: "Authentication", slug: "architecture/authentication" },
						{ label: "Client App", slug: "architecture/client" },
						{ label: "Sync Engine", slug: "architecture/sync" },
						{ label: "Federation", slug: "architecture/federation" },
						{ label: "Shared Packages", slug: "architecture/packages" },
					],
				},
				{
					label: "Provider Guides",
					collapsed: true,
					items: [
						{ label: "Google Calendar", slug: "providers/google" },
						{ label: "Microsoft / Outlook", slug: "providers/microsoft" },
						{ label: "Apple & CalDAV", slug: "providers/caldav" },
					],
				},
				{
					label: "Reference",
					collapsed: true,
					items: [
						{ label: "Commands & Checks", slug: "reference/commands" },
						{ label: "Environment Variables", slug: "reference/environment" },
						{ label: "HTTP API", slug: "reference/api" },
						{ label: "Reminders", slug: "reference/reminders" },
						{ label: "Glossary", slug: "architecture/glossary" },
					],
				},
				{
					label: "Operations",
					collapsed: true,
					items: [
						{ label: "Self-Hosting", slug: "guides/self-hosting" },
						{ label: "Capabilities & Verification", slug: "operations/capabilities" },
						{ label: "Releases & Upgrades", slug: "operations/releases" },
						{ label: "Observability", slug: "operations/observability" },
						{ label: "Android Widgets", slug: "guides/widgets" },
						{
							label: "Google Play Release",
							slug: "guides/google-play-release",
						},
					],
				},
				{
					label: "Contributing",
					items: [
						{ label: "Contributing Guide", slug: "guides/contributing" },
						{
							label: "Documentation Guide",
							slug: "contributing/documentation",
						},
					],
				},
			],
		}),
	],

	adapter: node({
		mode: "standalone",
	}),
});
