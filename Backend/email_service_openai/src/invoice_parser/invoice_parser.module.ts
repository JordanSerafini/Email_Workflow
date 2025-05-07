import { Module } from '@nestjs/common';
import { InvoiceParserController } from './invoice_parser.controller';
import { InvoiceParserService } from './invoice_parser.service';

@Module({
  controllers: [InvoiceParserController],
  providers: [InvoiceParserService],
  exports: [InvoiceParserService],
})
export class InvoiceParserModule {}
