import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AppService } from './model.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('model')
  async callModel(@Body() query: string): Promise<string> {
    try {
      return await this.appService.callModel(query);
    } catch (error) {
      console.error(error);
      throw new HttpException(
        'Error calling model',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
