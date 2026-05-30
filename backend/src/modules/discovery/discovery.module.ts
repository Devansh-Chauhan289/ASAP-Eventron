import { Module } from '@nestjs/common';
import { DiscoveryController } from './interface/discovery.controller';
import { DiscoveryService } from './application/discovery.service';

/** Discovery (supporting, read-only). Depends on the global Provider Integration ACL. */
@Module({
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
})
export class DiscoveryModule {}
