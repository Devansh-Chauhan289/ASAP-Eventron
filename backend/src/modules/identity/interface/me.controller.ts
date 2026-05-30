import { Body, Controller, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthService } from '../application/auth.service';
import { RegisterDeviceDto, UpdateProfileDto } from './dto/auth.dto';
import {
  CurrentUser,
  AuthUser,
} from '@shared/common/decorators/current-user.decorator';

@ApiTags('me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(private readonly auth: AuthService) {}

  @Get()
  me(@CurrentUser() user: AuthUser) {
    return this.auth.getProfile(user.userId);
  }

  @Patch()
  update(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto) {
    return this.auth.updateProfile(user.userId, dto);
  }

  @Post('devices')
  @HttpCode(204)
  async registerDevice(
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceDto,
  ) {
    await this.auth.registerDevice(user.userId, dto.token, dto.platform);
  }
}
