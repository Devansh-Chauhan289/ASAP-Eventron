import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request } from 'express';
import { StripeWebhookService } from '../application/stripe-webhook.service';
import { Public } from '@shared/common/decorators/public.decorator';

/**
 * Server-to-server Stripe webhook (never called by the frontend). Requires the RAW body for
 * signature verification — main.ts registers a raw-body parser for this path.
 */
@ApiExcludeController()
@Controller({ path: 'webhooks/stripe', version: '1' })
export class StripeWebhookController {
  constructor(private readonly webhook: StripeWebhookService) {}

  @Public()
  @Post()
  @HttpCode(200)
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature?: string,
  ): Promise<{ received: true }> {
    if (!signature) throw new BadRequestException('Missing stripe-signature');
    const raw = req.rawBody ?? (req.body as Buffer);
    await this.webhook.handle(raw, signature);
    return { received: true };
  }
}
