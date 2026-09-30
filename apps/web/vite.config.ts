import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
	build: {
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
