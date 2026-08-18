import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { StorageModule } from '../storage/storage.module';
import { CollaborationService } from './collaboration.service';

@Module({
  imports: [RealtimeModule, StorageModule],
  providers: [CollaborationService],
  exports: [CollaborationService],
})
export class CollaborationModule {}