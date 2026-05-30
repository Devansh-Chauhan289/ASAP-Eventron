import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './interface/auth.controller';
import { MeController } from './interface/me.controller';
import { AuthService } from './application/auth.service';
import { UserRepository } from './infrastructure/user.repository';
import { UsersFacade } from './users.facade';

/**
 * Identity & Access (supporting context). Exposes JWT issuance/verification used by the
 * global JwtAuthGuard. JwtModule is registered (empty) — secrets are passed per-sign/verify
 * from AppConfig so access and refresh use distinct keys.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController, MeController],
  providers: [AuthService, UserRepository, UsersFacade],
  exports: [JwtModule, UsersFacade],
})
export class IdentityModule {}
