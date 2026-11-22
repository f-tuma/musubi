import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
		// Maps without a sourceMappingURL comment, which the web image uploads
		// to Rustrak/Sentry on start (see Dockerfile).
		sourcemap: "hidden",
		rolldownOptions: {
			output: {
				// Shared schema and route chunks form cycles. Initialize their source
				// modules in order so a schema never runs before Zod's constructors.
				strictExecutionOrder: true,
			},
		},
	},
	plugins: [
		tailwindcss(),
		tanstackStart({
			srcDirectory: "src",
		}),
		viteReact(),
		nitro({
			// Register this executable server route explicitly. Nitro otherwise
			// classifies .js/serviceworker requests as Vite assets in dev.
			handlers: (["GET", "HEAD"] as const).map((method) => ({
				route: "/app/sw.js",
				method,
				handler: fileURLToPath(new URL("./src/server/worker-route.ts", import.meta.url)),
			})),
			routeRules: {
				"/**": {
					headers: {
						"content-security-policy": "frame-ancestors 'none'",
						"referrer-policy": "no-referrer",
						"x-content-type-options": "nosniff",
						"x-frame-options": "DENY",
					},
				},
			},
			devProxy: {
				"/api/**": {
					changeOrigin: true,
					target: "http://127.0.0.1:7531",
				},
			},
		}),
		// Stamps each chunk and its map with a debug ID during the build, before
		// Nitro records asset sizes. No upload here: the image does it at runtime
		// with the operator's credentials, so one public build serves every install.
		sentryVitePlugin({
			release: { create: false, inject: false, name: "" },
			sourcemaps: { disable: "disable-upload" },
			telemetry: false,
		}),
	],
	resolve: {
		tsconfigPaths: true,
	},
	ssr: {
		noExternal: ["rrule"],
	},
	server: {
		allowedHosts: ["3000.f-tuma.dev"],
		port: 3000,
		proxy: {
			"/api": {
				changeOrigin: true,
				target: "http://127.0.0.1:7531",
			},
		},
	},
});
