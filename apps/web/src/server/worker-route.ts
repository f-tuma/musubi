import { defineHandler } from "nitro/h3";
import { fetchViteEnv } from "nitro/vite/runtime";

// Keep Start's GET/HEAD handling authoritative; only declare the Nitro dispatch.
export default defineHandler(event => fetchViteEnv("ssr", event.req));
