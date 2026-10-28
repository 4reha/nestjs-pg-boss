import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Lets SIGTERM finish the jobs that are running before the process exits.
  app.enableShutdownHooks();
  await app.listen(3000);
}

void bootstrap();
