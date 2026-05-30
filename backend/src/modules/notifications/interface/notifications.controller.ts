import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { NotificationService } from '../application/notification.service';
import {
  CurrentUser,
  AuthUser,
} from '@shared/common/decorators/current-user.decorator';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
  constructor(private readonly service: NotificationService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('limit') limitRaw?: string,
  ) {
    const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 50);
    const rows = await this.service.listForUser(user.userId, limit);
    return {
      data: rows.map((n) => ({
        id: n.id,
        templateId: n.templateId,
        status: n.status,
        payload: n.payload,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  @Post(':id/read')
  @HttpCode(204)
  async read(@Param('id', ParseUUIDPipe) id: string) {
    await this.service.markRead(id);
  }
}
