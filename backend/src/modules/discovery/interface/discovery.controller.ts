import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { DiscoveryService } from '../application/discovery.service';
import { Public } from '@shared/common/decorators/public.decorator';

@ApiTags('discovery')
@Controller({ version: '1' })
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Public()
  @Get('events/search')
  async search(
    @Query('q') q?: string,
    @Query('city') city?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 50);
    const events = await this.discovery.search({ q, city, from, to, limit });
    return {
      data: events.map((e) => ({
        id: e.externalId,
        provider: e.provider,
        externalId: e.externalId,
        title: e.title,
        category: e.category,
        venue: e.venue,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        priceFrom: e.priceFrom,
        imageUrl: e.imageUrl,
        availability: e.availability,
      })),
      pageInfo: { nextCursor: null, hasMore: false },
    };
  }

  @Public()
  @Get('events/:externalId')
  async getEvent(@Param('externalId') externalId: string) {
    return this.discovery.getEvent(externalId);
  }

  @Get('recommendations/trip')
  recommend(@Query('eventId') eventId: string) {
    return this.discovery.recommendTrip(eventId);
  }
}
