import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config, logger } from "@musubi/config";

/**
 * The mark at the top of every email, and where its footer points.
 *
 * One module so the five templates cannot drift apart — the whole reason this
 * exists is that the wordmark in the footer had been `href="#"` in all of them
 * at once, and nobody was going to notice it five times.
 */

/** Referenced as `cid:musubi-logo` in the markup; `sendEmail` attaches it. */
export const LOGO_CID = "musubi-logo";

// Frozen Vardum export of brand/logo/light: 128px PNG, 3.91% padding and alpha,
// shown at 44px so it stays sharp on a retina screen. The committed asset and
// assets/.vardum.lock refresh together; mail never fetches Vardum at runtime.
// PNG, not SVG: Gmail drops SVG entirely and Outlook never supported it, so
// the whole header would silently vanish.
const LOGO_PATH = join(__dirname, "..", "assets", "logo.png");

let logo: Buffer | null | undefined;

/**
 * The inline attachment, or null when the file is not where it should be.
 *
 * Travelling with the message rather than being fetched from a URL is what
 * makes this work for a self-hosted server with no public domain — and it
 * means no client has to be told to "display images" first.
 */
export function logoAttachment() {
  if (logo === undefined) {
    try {
      logo = readFileSync(LOGO_PATH);
    } catch (error) {
      // Not fatal: the `alt` text still says Musubi and the mail still sends.
      // Logged because a missing asset in a container is otherwise invisible.
      logo = null;
      logger.warn("email.logo_missing", { error, path: LOGO_PATH });
    }
  }

  return logo
    ? [{ cid: LOGO_CID, content: logo, filename: "musubi.png" }]
    : [];
}

/**
 * Where the footer wordmark goes: this server's own origin.
 *
 * Not a hard-coded musubi.pro — somebody running their own instance should be
 * sent to their own instance, not to somebody else's marketing site.
 */
export function brandUrl() {
  return config.api.url;
}

/**
 * The one button an email carries.
 *
 * Two tones, and they are the app's own (`packages/design-system` dark theme),
 * not a third vocabulary invented for mail:
 *
 * - `primary` is the cream control fill — confirm, reset, approve.
 * - `destructive` is the shu accent — and in the app that is what the accent
 *   MEANS. Every email used to be accent-filled, so the one button that
 *   permanently deletes an account looked exactly like the one that confirms an
 *   address. Now it is the only one wearing that colour.
 *
 * Black on the accent rather than white: it clears 4.5:1, and white does not.
 *
 * The `<span>`s and `mso-` properties are Outlook's price for a padded link.
 */
export function button(
  href: string,
  label: string,
  tone: "destructive" | "primary" = "primary",
) {
  const [background, text] =
    tone === "destructive" ? ["#c8553d", "#000000"] : ["#e8e4d9", "#0c0c0e"];

  return `<a
                                class="button"
                                href="${href}"
                                style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:0;padding-top:12px;padding-right:24px;padding-bottom:12px;padding-left:24px;background-color:${background};color:${text};border-radius:8px;font-weight:500;font-size:0.875em;text-align:center;margin-top:24px;margin-bottom:24px"
                                target="_blank"
                                ><span></span><span
                                  style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px"
                                  >${label}</span><span></span></a>`;
}

/**
 * Anything a user typed, on its way into an HTML email.
 *
 * Names and addresses are user input. An email client runs no scripts, so this
 * is not the same danger as a web page — but an unescaped `<` still lets one
 * person post markup into another person's inbox, and a name containing an
 * anchor tag would arrive as a working link somebody else's client renders.
 */
export function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/** The header mark. `display:block` and real width/height are for Outlook. */
export function logoMarkup() {
  return `<img
                        src="cid:${LOGO_CID}"
                        alt="Musubi"
                        width="44"
                        height="44"
                        style="display:block;border:0;outline:none;text-decoration:none;margin-bottom:24px" />`;
}
