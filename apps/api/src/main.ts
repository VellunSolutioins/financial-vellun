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

const allowedOrigins = [
  process.env.WEB_URL,
  'http://localhost:3000',
  'https://financial-vellun-web.vercel.app',
]
  .filter(Boolean)
  .map((origin) => origin!.replace(/\/$/, ''));

function isAllowedOrigin(origin?: string): boolean {
  if (!origin) return true;

  const normalizedOrigin = origin.replace(/\/$/, '');
  return (
    allowedOrigins.includes(normalizedOrigin) ||
    /^https:\/\/financial-vellun-web(?:-[a-z0-9-]+)?\.vercel\.app$/.test(normalizedOrigin)
  );
}

async function bootstrap() {
  // `rawBody: true` expõe `req.rawBody` (Buffer) para a validação de assinatura
  // do webhook do PSP, sem desabilitar o body parser usado pelo ValidationPipe.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  app.enableCors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    optionsSuccessStatus: 204,
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
