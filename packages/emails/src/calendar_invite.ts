import { brandUrl, button, escapeHtml, logoMarkup } from "./brand";

/**
 * "Somebody wants to share a calendar with you."
 *
 * The only email Musubi sends to an address that may never have heard of it,
 * so it says who is asking and what they are offering before it asks for
 * anything. No preference gates it: a person typed this address and pressed
 * send, which makes it transactional like a password reset rather than a
 * notification somebody can be subscribed to.
 */
export function getCalendarInviteHtml(
  inviterName: string,
  calendarName: string,
  inviteUrl: string,
  expiresIn: string | null,
) {
  const expiry = expiresIn
    ? `This invitation expires in ${escapeHtml(expiresIn)}.`
    : "This invitation does not expire.";

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
                        ${escapeHtml(inviterName)} shared a calendar with you
                      </h1>
                      <p
                        style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em;color:#d4d4dc;line-height:160%">
                        It is called ${escapeHtml(calendarName)}. Musubi is a shared calendar —
                        opening this shows you what is on it before you decide to join.
                      </p>
                      ${button(inviteUrl, "See the calendar")}
                      <p
                        style="margin:0;padding:0;font-size:13px;padding-top:0.5em;padding-bottom:0.5em;color:#8a8a94;line-height:160%">
                        ${expiry} If the button above doesn't work, paste this link into your
                        browser:
                      </p>
                      <p style="margin:0;padding:0;font-size:13px;line-height:160%">
                        <a
                          href="${inviteUrl}"
                          style="color:#C8553D;text-decoration:underline"
                          target="_blank"
                          >${escapeHtml(inviteUrl)}</a>
                      </p>
                      <p
                        style="margin:0;padding:0;font-size:12px;padding-top:1.5em;padding-bottom:0.5em;color:#6b6b75;line-height:160%">
                        Weren't expecting this? Somebody typed your address into Musubi. Ignore
                        this email — nothing is shared with you unless you open the link, and no
                        account is created for you.
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
