import { Module } from '@nestjs/common';
import { AnalyzeEmailService } from './analyze_email.service';
import { AnalyzeEmailController } from './analyze_email.controller';

@Module({
  providers: [AnalyzeEmailService],
  controllers: [AnalyzeEmailController],
  exports: [AnalyzeEmailService],
})
export class AnalyzeEmailModule {}
