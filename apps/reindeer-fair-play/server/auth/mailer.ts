/**
 * Mail delivery for sign-in links, reusing the monorepo's shared mailer
 * rather than writing a second one.
 *
 * `mailerFromEnv` (from @reindeer/delivery) defaults to `ConsoleMailer`,
 * which writes the message to disk and sends nothing, UNLESS SMTP settings
 * are present in the environment. That is the safety property this file
 * must never weaken: no development machine may ever send real mail by
 * accident. Tests use `RecordingMailer` explicitly (see selftest.mts) so no
 * mail hits disk or a network socket during automated runs either.
 */
import { mailerFromEnv, type Mailer } from "@reindeer/delivery";

let cachedMailer: Mailer | null = null;

/** The process-wide mailer instance. Cached so ConsoleMailer's directory (and any SMTP transport) is reused. */
export function getMailer(): Mailer {
  if (!cachedMailer) cachedMailer = mailerFromEnv();
  return cachedMailer;
}

/** Test-only: force a specific mailer (e.g. RecordingMailer) for the rest of the process. */
export function setMailerForTests(mailer: Mailer): void {
  cachedMailer = mailer;
}

export type SendMagicLinkInput = {
  to: string;
  participantName: string;
  estateTitle: string;
  linkUrl: string;
  shortCode: string;
  isInvite: boolean;
};

/**
 * Sends the sign-in email. Plain language throughout — this may be read by
 * an elderly heir with no technical background. The 6-character short code
 * is always included in the body so it can be read aloud over the phone to
 * someone who cannot open the link themselves.
 */
export async function sendMagicLinkEmail(input: SendMagicLinkInput) {
  const greeting = input.isInvite
    ? `You've been added to ${input.estateTitle}.`
    : `Here is your sign-in link for ${input.estateTitle}.`;

  const text = [
    `Hello ${input.participantName},`,
    "",
    greeting,
    "",
    `Click this link to continue: ${input.linkUrl}`,
    "",
    `If the link doesn't work, you can also type this 6-character code where the site asks for it: ${input.shortCode}`,
    "",
    "If someone needs help, they can read this code out loud over the phone.",
    "",
    "This link works once and stops working in 20 minutes. If it expires, just ask for a new one.",
    "",
    "If you didn't expect this message, you can ignore it — nothing happens until the link is used.",
  ].join("\n");

  const html = [
    `<p>Hello ${escapeHtml(input.participantName)},</p>`,
    `<p>${escapeHtml(greeting)}</p>`,
    `<p><a href="${escapeHtml(input.linkUrl)}">Click here to continue</a></p>`,
    `<p>If the link doesn't work, you can also type this 6-character code where the site asks for it: <strong>${escapeHtml(input.shortCode)}</strong></p>`,
    `<p>If someone needs help, they can read this code out loud over the phone.</p>`,
    `<p>This link works once and stops working in 20 minutes. If it expires, just ask for a new one.</p>`,
    `<p>If you didn't expect this message, you can ignore it — nothing happens until the link is used.</p>`,
  ].join("\n");

  return getMailer().send({
    to: input.to,
    subject: input.isInvite
      ? `You've been added to ${input.estateTitle}`
      : `Your sign-in link for ${input.estateTitle}`,
    text,
    html,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
