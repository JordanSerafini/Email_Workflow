import { Controller, Get, Param, Post } from '@nestjs/common';
import { InvoiceParserService } from './invoice_parser.service';

@Controller('invoice-parser')
export class InvoiceParserController {
  constructor(private readonly invoiceParserService: InvoiceParserService) {}

  @Get('files')
  async getInvoiceFiles() {
    return this.invoiceParserService.getInvoiceFiles();
  }

  @Get('process/:filename')
  async processInvoice(@Param('filename') filename: string) {
    return this.invoiceParserService.processInvoice(filename);
  }

  @Post('process-all')
  async processAllInvoices() {
    return this.invoiceParserService.processAllInvoices();
  }
}
