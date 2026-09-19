import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { isAllowedWebOrigin } from './common/http-origin.util';
import { CORRELATION_HEADER } from './observability/correlation';
import { AppLoggerService } from './observability/app-logger.service';

const isProduction = process.env.NODE_ENV === 'production';

// Fuso horário da aplicação: Brasil (America/Sao_Paulo). Definido antes do
// bootstrap para que `new Date()`, timestamps e os cálculos do dashboard usem
// o horário de Brasília.
process.env.TZ = process.env.TZ ?? 'America/Sao_Paulo';

async function bootstrap() {
  // `rawBody: true` expõe `req.rawBody` (Buffer) para a validação de assinatura
  // do webhook do PSP, sem desabilitar o body parser usado pelo ValidationPipe.
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });

  // Troca o logger do Nest pelo estruturado. `bufferLogs` acima retém o que for
  // logado durante o bootstrap para que também saia no formato novo — sem isso,
  // erros de inicialização (os mais difíceis de diagnosticar) ficariam de fora.
  app.useLogger(app.get(AppLoggerService));

  // Headers de segurança (Helmet). CSP estrito só em produção; em dev fica
  // desabilitado para não bloquear o Swagger UI.
  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  app.enableCors({
    origin(origin, callback) {
      if (!origin || isAllowedWebOrigin(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'X-CSRF-Token',
      CORRELATION_HEADER,
    ],
    // Sem expor o header, o browser não deixa o frontend ler o id da resposta —
    // e é ele que permite levar um erro visto na tela direto para o Loki.
    exposedHeaders: [CORRELATION_HEADER],
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

  // Swagger fica desabilitado em produção para não expor a superfície da API.
  if (!isProduction) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Financial Vellun API')
      .setDescription('API principal de controle financeiro')
      .setVersion('1.0')
      .addCookieAuth('access_token')
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  const port = process.env.PORT ?? process.env.API_PORT ?? 3001;

  try {
    await app.listen(port);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;

    if (nodeError.code === 'EADDRINUSE') {
      console.error(
        `A porta ${port} ja esta em uso. Encerre o processo existente ou altere API_PORT.`,
      );
      process.exit(1);
    }

    throw error;
  }

  console.log(`API rodando em http://localhost:${port}`);
  console.log(`Swagger disponível em http://localhost:${port}/api/docs`);
}

bootstrap();
