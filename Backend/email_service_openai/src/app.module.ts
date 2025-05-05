import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { SortEmailModule } from './sort_email/sort_email.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    SortEmailModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
