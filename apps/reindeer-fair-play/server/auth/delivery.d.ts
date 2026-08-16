/**
 * Hand-written ambient types for `@reindeer/delivery`'s mailer module.
 *
 * The package is plain ESM JavaScript with no type declarations of its own.
 * This module only describes the surface server/auth/mailer.ts actually
 * imports, shaped from packages/reindeer-delivery/src/mailer.js.
 *
 * Keep this in sync with that file if the delivery package's mailer changes.
 */
declare module "@reindeer/delivery" {
  export interface MailAttachment {
    filename: string;
    content: Buffer | string;
  }

  export interface MailMessage {
    to: string | string[];
    cc?: string | string[];
    subject: string;
    text: string;
    html?: string;
    attachments?: MailAttachment[];
  }

  export interface MailSendResult {
    ok: boolean;
    message_id?: string;
    accepted?: string[];
    error?: string;
    written_to?: string;
  }

  export abstract class Mailer {
    send(message: MailMessage): Promise<MailSendResult>;
    readonly describe: string;
  }

  export class SmtpMailer extends Mailer {
    constructor(config: {
      host: string;
      port?: number;
      secure?: boolean;
      user?: string;
      pass?: string;
      from?: string;
    });
    verify(): Promise<{ ok: boolean; error?: string }>;
  }

  export class ConsoleMailer extends Mailer {
    constructor(outDir: string);
    readonly outDir: string;
  }

  export class RecordingMailer extends Mailer {
    constructor();
    sent: MailMessage[];
    failNext: string | null;
  }

  export function mailerFromEnv(
    env?: Record<string, string | undefined>,
    fallbackDir?: string,
  ): Mailer;
}
