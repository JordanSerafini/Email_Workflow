import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Activer CORS pour toutes les origines
  app.enableCors({
    origin: '*',
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Démarrer le serveur sur le port 4444
  await app.listen(4444);
  logger.log(`Le serveur est démarré sur le port 4444`);
}
void bootstrap();
