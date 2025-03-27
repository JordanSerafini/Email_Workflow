import { Module } from '@nestjs/common';
import { AppController } from './model/model.controller';
import { AppService } from './model/model.service';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
