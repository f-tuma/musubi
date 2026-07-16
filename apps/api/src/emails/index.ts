import { config, logger } from "@musubi/config";
import nodemailer from "nodemailer";

export async function sendEmail(to: string, subject: string, html: string) {
  try {
    // Create transport
    const transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.port === 465 ? true : false, // false for TLS (587), true for SSL (465)
      auth: {
        user: config.smtp.user,
        pass: config.smtp.pass,
      },
    });

    // Define the email content
    const mailOptions = {
      from: config.smtp.from,
      to: to,
      subject: subject,
      html: html,
    };

    // Send the email
    const info = await transporter.sendMail(mailOptions);
    logger.info("email.sent", { messageId: info.messageId });
  } catch (error) {
    logger.error("email.send_failed", { error });
    throw error;
  }
  return;
};
