import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';

import { AppModule } from './app.module';

// Fuso horário da aplicação: Brasil (America/Sao_Paulo). Definido antes do
// bootstrap para que `new Date()`, timestamps e os cálculos do dashboard usem
// o horário de Brasília.
process.env.TZ = process.env.TZ ?? 'America/Sao_Paulo';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: process.env.WEB_URL ?? 'http://localhost:3000',
    credentials: true,
  });

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Financial Vellun API')
    .setDescription('API principal de controle financeiro')
    .setVersion('1.0')
    .addCookieAuth('access_token')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? process.env.API_PORT ?? 3001;

  try {
    await app.listen(port);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === 'EADDRINUSE') {
      console.error(`A porta ${port} ja esta em uso. Encerre o processo existente ou altere API_PORT.`);
      process.exit(1);
    }

    throw error;
  }

  console.log(`API rodando em http://localhost:${port}`);
  console.log(`Swagger disponível em http://localhost:${port}/api/docs`);
}

bootstrap();
