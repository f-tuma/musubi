

export function getDeleteAccountHtml(userName: string, confirmUrl: string, expiresIn: string) {
  return `
  <!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
  <html dir="ltr" lang="en">
    <head>
      <meta content="width=device-width" name="viewport" />
      <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
      <meta name="x-apple-disable-message-reformatting" />
      <meta content="IE=edge" http-equiv="X-UA-Compatible" />
      <meta name="x-apple-disable-message-reformatting" />
      <meta
        content="telephone=no,address=no,email=no,date=no,url=no"
        name="format-detection" />
    </head>
    <body style="background-color:#050507;padding-top:0;padding-bottom:0">
      <div
        style="display:none;overflow:hidden;line-height:1px;opacity:0;max-height:0;max-width:0"
        data-skip-in-text="true">
        Confirm you want to permanently delete your Musubi account.
        <div>
            ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏﻿ ‌​‍‎‏
        </div>
      </div>
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
              style="font-family:-apple-system, BlinkMacSystemFont, &#x27;Segoe UI&#x27;, &#x27;Roboto&#x27;, &#x27;Oxygen&#x27;, &#x27;Ubuntu&#x27;, &#x27;Cantarell&#x27;, &#x27;Fira Sans&#x27;, &#x27;Droid Sans&#x27;, &#x27;Helvetica Neue&#x27;, sans-serif;font-size:14px;min-height:100%;line-height:155%;background-color:#050507;padding-top:48px;padding-bottom:48px">
              <table
                align="center"
                width="100%"
                border="0"
                cellpadding="0"
                cellspacing="0"
                role="presentation"
                style="max-width:600px;background-color:#0e0e12;width:100%;align:center;margin-top:48px;margin-bottom:48px;padding-top:40px;padding-right:40px;padding-bottom:40px;padding-left:40px;border-radius:12px;border-width:1px;border-color:#1f1f26;border-style:solid">
                <tbody>
                  <tr style="width:100%">
                    <td>
                      <h1
                        style="margin:0;padding:0;font-size:26px;line-height:1.44em;padding-top:0.389em;font-weight:700;color:#ffffff;margin-bottom:16px">
                        Confirm account deletion
                      </h1>
                      <p
                        style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em;color:#d4d4dc;line-height:160%">
                        Hi ${userName}, we received a request to permanently
                        delete your Musubi account. This removes your calendars,
                        events, shared access, and connected calendar
                        credentials, and cannot be undone. Click the button below
                        to confirm.
                      </p>
                      <table
                        align="center"
                        width="100%"
                        border="0"
                        cellpadding="0"
                        cellspacing="0"
                        role="presentation">
                        <tbody style="width:100%">
                          <tr style="width:100%">
                            <td align="left" data-id="__react-email-column">
                              <a
                                class="button"
                                href="${confirmUrl}"
                                style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;margin:0;padding:0;padding-top:12px;padding-right:24px;padding-bottom:12px;padding-left:24px;background-color:#C8553D;color:#ffffff;border-radius:8px;font-weight:500;font-size:0.875em;text-align:center;margin-top:24px;margin-bottom:24px"
                                target="_blank"
                                ><span></span><span
                                  style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px"
                                  >Delete my account</span><span></span></a>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <p
                        style="margin:0;padding:0;font-size:13px;padding-top:0.5em;padding-bottom:0.5em;color:#8a8a94;line-height:160%">
                        This link will expire in ${expiresIn}. If the button above
                        doesn&#x27;t work, paste this link into your browser:
                      </p>
                      <p
                        style="margin:0;padding:0;font-size:13px;padding-top:0.5em;padding-bottom:0.5em;color:#8a8a94;line-height:160%;word-break:break-all">
                        <a
                          href="${confirmUrl}"
                          rel="noopener noreferrer nofollow"
                          style="color:#C8553D;text-decoration-line:none;text-decoration:underline"
                          target="_blank"
                          >${confirmUrl}</a>
                      </p>
                      <hr
                        class="divider"
                        style="width:100%;border:none;border-color:#1f1f26;border-top:1px solid #eaeaea;padding-bottom:1em;border-style:solid;border-width:0;border-top-width:2px;margin-top:32px;margin-bottom:24px" />
                      <p
                        style="margin:0;padding:0;font-size:12px;padding-top:0.5em;padding-bottom:0.5em;color:#6b6b75;line-height:160%">
                        Didn&#x27;t request this? You can safely ignore this email
                        — your account won&#x27;t be deleted unless you click the
                        link above.
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
                                  href="#"
                                  rel="noopener noreferrer nofollow"
                                  style="color:#C8553D;text-decoration-line:none;text-decoration:underline"
                                  target="_blank"
                                  >Musubi</a><br /><br />© ${new Date().getFullYear()} FRGTN
                              </p>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                      <p
                        style="margin:0;padding:0;font-size:1em;padding-top:0.5em;padding-bottom:0.5em;color:#d4d4dc;line-height:160%">
                        <br />
                      </p>
                    </td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>
        </tbody>
      </table>
    </body>
  </html>
`}
