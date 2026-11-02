import { brandUrl, escapeHtml, logoMarkup } from "./brand";

export type EventChange = {
  /** "cancelled" or the new time, already formatted in the reader's zone. */
  kind: "cancelled" | "moved";
  title: string;
  /** When it is now. Absent for a cancellation, which has no new time. */
  when?: string;
  /** Where it used to be, so a move reads as a change rather than an event. */
  wasWhen?: string;
};

/**
 * "Something you were going to has changed."
 *
 * One email can carry several changes: somebody rearranging a week should
 * produce one message, not twenty (see `pending_notifications`). The list is
 * the whole content — there is no call to action, because there is nothing the
 * reader has to do, and a button here would only invite a pointless click.
 */
export function getEventChangesHtml(userName: string, changes: EventChange[]) {
  const heading =
    changes.length === 1
      ? changes[0]!.kind === "cancelled"
        ? "An event was cancelled"
        : "An event moved"
      : "Some events changed";

  const rows = changes
    .map((change) => {
      const detail =
        change.kind === "cancelled"
          ? `Cancelled${change.wasWhen ? ` — was ${escapeHtml(change.wasWhen)}` : ""}`
          : `${escapeHtml(change.when ?? "")}${
              change.wasWhen ? ` — was ${escapeHtml(change.wasWhen)}` : ""
            }`;

      return `<tr>
                            <td style="padding-top:12px;padding-bottom:12px;border-bottom:1px solid #1f1f26">
                              <p style="margin:0;padding:0;font-size:15px;color:#ffffff;line-height:150%">
                                ${escapeHtml(change.title)}
                              </p>
                              <p style="margin:0;padding:0;font-size:13px;color:#8a8a94;line-height:150%">
                                ${detail}
                              </p>
                            </td>
                          </tr>`;
    })
    .join("");

  return `
  <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
  <html dir="ltr" lang="en">
    <head>
      <meta content="width=device-width" name="viewport" />
      <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
      <meta name="x-apple-disable-message-reformatting" />
      <meta content="IE=edge" http-equiv="X-UA-Compatible" />
      <meta
        content="telephone=no,address=no,email=no,date=no,url=no"
        name="format-detection" />
    </head>
    <body style="background-color:#050507;padding-top:0;padding-bottom:0">
      <table
        border="0"
        width="100%"
        cellpadding="0"
        cellspacing="0"
        role="presentation"
        align="center">
        <tbody>
          <tr>
            <td
              style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;font-size:14px;min-height:100%;line-height:155%;background-color:#050507;padding-top:48px;padding-bottom:48px">
              <table
                align="center"
                width="100%"
                border="0"
                cellpadding="0"
                cellspacing="0"
                role="presentation"
                style="max-width:600px;background-color:#0e0e12;width:100%;margin-top:48px;margin-bottom:48px;padding-top:40px;padding-right:40px;padding-bottom:40px;padding-left:40px;border-radius:12px;border-width:1px;border-color:#1f1f26;border-style:solid">
                <tbody>
                  <tr style="width:100%">
                    <td>
                      ${logoMarkup()}<h1
                        style="margin:0;padding:0;font-size:26px;line-height:1.44em;padding-top:0.389em;font-weight:700;color:#ffffff;margin-bottom:16px">
                        ${heading}
                      </h1>
                      <p
                        style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em;color:#d4d4dc;line-height:160%">
                        Hi ${escapeHtml(userName)}, this is what changed on events you are
                        attending.
                      </p>
                      <table
                        align="center"
                        width="100%"
                        border="0"
                        cellpadding="0"
                        cellspacing="0"
                        role="presentation"
                        style="margin-top:16px;margin-bottom:16px">
                        <tbody>
                          ${rows}
                        </tbody>
                      </table>
                      <p
                        style="margin:0;padding:0;font-size:12px;padding-top:0.5em;padding-bottom:0.5em;color:#6b6b75;line-height:160%">
                        You are getting this because you are on the guest list. Turn it off
                        under Email me when, in settings.
                      </p>
                      <table
                        align="center"
                        width="100%"
                        border="0"
                        cellpadding="0"
                        cellspacing="0"
                        role="presentation"
                        class="node-footer"
                        style="font-size:0.8em;padding-top:24px">
                        <tbody>
                          <tr>
                            <td>
                              <p
                                style="margin:0;padding:0;font-size:12px;padding-top:0.5em;padding-bottom:0.5em;color:#6b6b75;line-height:160%">
                                <a
                                  href="${brandUrl()}"
                                  rel="noopener noreferrer nofollow"
                                  style="color:#C8553D;text-decoration-line:none;text-decoration:underline"
                                  target="_blank"
                                  >Musubi</a><br /><br />© ${new Date().getFullYear()} Filip Tůma
                              </p>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>
    </body>
  </html>`;
}
