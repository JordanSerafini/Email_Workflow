import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsappModule } from './whatsapp/whatsapp.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    WhatsappModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
