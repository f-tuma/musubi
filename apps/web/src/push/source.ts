import { BRAND_ASSETS } from "~/brand";
import source from "~/push/service-worker.js?raw";

export const serviceWorkerSource = `const NOTIFICATION_ICON = ${JSON.stringify(BRAND_ASSETS.notificationIcon)};\n${source}`;
