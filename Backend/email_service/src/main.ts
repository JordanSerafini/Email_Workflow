import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.PORT ?? 3000);
}

void (async () => {
  try {
    await bootstrap();
  } catch (error) {
    console.error(error);
  }
})();
