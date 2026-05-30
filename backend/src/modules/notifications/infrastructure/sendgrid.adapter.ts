import { Injectable, Logger } from '@nestjs/common';
import sgMail from '@sendgrid/mail';
import { AppConfig } from '@shared/config/config.module';
import { assertNotInTransaction } from '@shared/prisma/tx-context';

/**
 * SendGrid email adapter (Section 12). If no API key is configured (local dev), it logs the
 * message instead of sending — so the booking flow works end-to-end without external email.
 */
@Injectable()
export class SendgridAdapter {
  private readonly logger = new Logger(SendgridAdapter.name);
  private readonly enabled: boolean;

  constructor(private readonly config: AppConfig) {
    this.enabled = !!this.config.sendgrid.apiKey;
    if (this.enabled) sgMail.setApiKey(this.config.sendgrid.apiKey);
  }

  async send(input: {
    to: string;
    subject: string;
    text: string;
  }): Promise<{ ok: boolean; response: Record<string, unknown> }> {
    assertNotInTransaction('SendGrid.send');
    if (!this.enabled) {
      this.logger.log(`[email:dev] to=${input.to} subject="${input.subject}"`);
      return { ok: true, response: { dev: true } };
    }
    try {
      const [res] = await sgMail.send({
        to: input.to,
        from: this.config.sendgrid.fromEmail,
        subject: input.subject,
        text: input.text,
      });
      return { ok: res.statusCode < 300, response: { status: res.statusCode } };
    } catch (e) {
      this.logger.error('SendGrid send failed', e as Error);
      return { ok: false, response: { error: (e as Error).message } };
    }
  }
}
