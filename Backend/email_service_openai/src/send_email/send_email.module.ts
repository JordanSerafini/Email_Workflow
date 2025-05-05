import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SendEmailController } from './send_email.controller';
import { SendEmailService } from './send_email.service';
import { AnalyzeEmailModule } from '../analyze_email/analyze_email.module';

@Module({
  imports: [ConfigModule, AnalyzeEmailModule],
  controllers: [SendEmailController],
  providers: [SendEmailService],
  exports: [SendEmailService],
})
export class SendEmailModule {}
