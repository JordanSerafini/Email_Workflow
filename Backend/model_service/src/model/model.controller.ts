import {
  Controller,
  Post,
  Body,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { AppService } from './model.service';

interface ModelRequest {
  query: string;
}

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Post('model')
  async callModel(@Body() body: ModelRequest): Promise<string> {
    try {
      return await this.appService.callModel(body.query);
    } catch (error: unknown) {
      console.error(error);
      const errorMessage =
        error instanceof Error ? error.message : 'Internal server error';
      throw new HttpException(errorMessage, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}
