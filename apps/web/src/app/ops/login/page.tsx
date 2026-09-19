'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { opsGithubLoginUrl } from '@/lib/ops-api-client';

/**
 * Mensagens por código de erro devolvido pelo callback do OAuth.
 *
 * "Fora da organização" e "aguardando ativação" são estados **diferentes** e o
 * operador precisa saber qual é o seu: no primeiro não há nada a esperar, no
 * segundo há.
 */
const errorMessages: Record<string, string> = {
  fora_da_organizacao:
    'Sua conta do GitHub não pertence à organização. Fale com quem administra a organização.',
  aguardando_ativacao:
    'Seu acesso foi registrado e está aguardando ativação por um administrador de operações.',
  state_invalido: 'O login expirou ou foi aberto em outra aba. Tente novamente.',
  code_ausente: 'O GitHub não devolveu a autorização. Tente novamente.',
  github_indisponivel: 'Não foi possível falar com o GitHub agora. Tente novamente em instantes.',
};

function LoginCard() {
  const erro = useSearchParams().get('erro');
  const message = erro ? (errorMessages[erro] ?? 'Não foi possível entrar.') : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Operações</CardTitle>
        <CardDescription>
          Acesso restrito. A identificação é feita pelo GitHub e exige pertencer à organização.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {message && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-foreground"
          >
            {message}
          </p>
        )}

        {/*
          Link de navegação, não `fetch`: o fluxo OAuth precisa que o browser
          saia da página para o GitHub e volte com o cookie de sessão.
        */}
        <Button asChild className="w-full">
          <a href={opsGithubLoginUrl()}>Entrar com GitHub</a>
        </Button>

        <p className="text-xs text-muted-foreground">
          Esta área é separada da sua conta do produto. Estar logado no Financial Vellun não dá
          acesso aqui.
        </p>
      </CardContent>
    </Card>
  );
}

export default function OpsLoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* `useSearchParams` exige Suspense em rota estática do App Router. */}
        <Suspense fallback={null}>
          <LoginCard />
        </Suspense>
      </div>
    </div>
  );
}
