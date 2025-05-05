import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT ?? 3003;
  
  await app.listen(port);
  logger.log(`Application WhatsApp Service démarrée sur le port ${port}`);
}
bootstrap();
