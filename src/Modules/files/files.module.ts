import { Module } from '@nestjs/common';
import { RepositoryModule } from 'src/common/database/repositories/repository.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { FileController } from './files.controller';
import { FileService } from './files.service';
import { S3Client } from '@aws-sdk/client-s3';
import { StorageModule } from '../storage/storage.module';
import { CollaborationModule } from '../collaboration/collaboration.module';

@Module({
  imports: [RepositoryModule, RealtimeModule, StorageModule, CollaborationModule],

  controllers: [FileController],
  providers: [FileService],
})
export class FileModule {}
