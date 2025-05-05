import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SortEmailModule } from './sort_email/sort_email.module';
import { InvoiceParserModule } from './invoice_parser/invoice_parser.module';
import { AnalyzeEmailModule } from './analyze_email/analyze_email.module';
import { SendEmailModule } from './send_email/send_email.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    SortEmailModule,
    InvoiceParserModule,
    AnalyzeEmailModule,
    SendEmailModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
