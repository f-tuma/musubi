import { envOrThrow } from "@musubi/config";
import nodemailer from "nodemailer";

export async function sendEmail(to: string, subject: string, html: string) {
  try {
    // Create transport
    const transporter = nodemailer.createTransport({
      host: envOrThrow("SMTP_HOST"),
      port: Number(envOrThrow("SMTP_PORT")),
      secure: envOrThrow("SMTP_PORT") === "465" ? true : false, // false for TLS (587), true for SSL (465)
      auth: {
        user: envOrThrow("SMTP_USER"),
        pass: envOrThrow("SMTP_PASS"),
      },
    });

    // Define the email content
    const mailOptions = {
      from: envOrThrow("FROM_EMAIL"),
      to: to,
      subject: subject,
      html: html,
    };

    // Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent:', info.messageId);
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
  return;
};
