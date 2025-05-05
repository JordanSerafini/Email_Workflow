import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SortEmailModule } from './sort_email/sort_email.module';
import { InvoiceParserModule } from './invoice_parser/invoice_parser.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    SortEmailModule,
    InvoiceParserModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
