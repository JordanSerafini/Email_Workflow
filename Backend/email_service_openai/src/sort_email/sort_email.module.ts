import { Module } from '@nestjs/common';
import { SortEmailController } from './sort_email.controller';
import { SortEmailService } from './sort_email.service';

@Module({
  controllers: [SortEmailController],
  providers: [SortEmailService],
  exports: [SortEmailService],
})
export class SortEmailModule {}
