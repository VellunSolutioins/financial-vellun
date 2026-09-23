'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Button } from '@/components/ui/button';
import { ApiClientError } from '@/lib/api-client';
import {
  type PhoneVerificationChallenge,
  formatBotNumber,
  getPhoneVerificationState,
  startPhoneVerification,
} from '@/lib/whatsapp';

const POLL_INTERVAL_MS = 3_000;

type Phase = 'loading' | 'pending' | 'expired' | 'verified' | 'error';

interface WhatsappVerificationProps {
  /** Número a verificar. Sem ele, a API usa o telefone do cadastro. */
  phone?: string;
  /** Senha atual, exigida pela API para trocar um número já verificado. */
  currentPassword?: string;
  onVerified?: () => void;
}

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Verificação de posse do WhatsApp: o usuário envia ao bot o código exibido
 * aqui, a partir do número que quer vincular.
 *
 * Mobile first: no celular, o botão abre o WhatsApp com a mensagem pronta e o
 * QR code não aparece (não há como lê-lo na mesma tela). A partir do `md`, o
 * QR code aparece ao lado do link, para ler com o celular ou abrir o WhatsApp
 * Desktop/Web. A tela consulta o status e avança sozinha quando o bot confirma.
 */
export function WhatsappVerification({
  phone,
  currentPassword,
  onVerified,
}: WhatsappVerificationProps) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [challenge, setChallenge] = useState<PhoneVerificationChallenge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const started = useRef(false);
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const generate = useCallback(async () => {
    setPhase('loading');
    setError(null);
    try {
      const created = await startPhoneVerification({ phone, currentPassword });
      setChallenge(created);
      setNow(Date.now());
      setPhase('pending');
    } catch (e) {
      setError(e instanceof ApiClientError ? e.message : 'Não foi possível gerar o código.');
      setPhase('error');
    }
  }, [phone, currentPassword]);

  // Gera o código uma vez ao montar (o StrictMode monta duas vezes em dev).
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void generate();
  }, [generate]);

  // Contagem regressiva até a expiração.
  useEffect(() => {
    if (phase !== 'pending') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [phase]);

  const expiresAt = challenge ? new Date(challenge.expiresAt).getTime() : 0;
  const remaining = expiresAt - now;

  useEffect(() => {
    if (phase === 'pending' && challenge && remaining <= 0) setPhase('expired');
  }, [phase, challenge, remaining]);

  // Consulta o status até o bot confirmar o código.
  useEffect(() => {
    if (phase !== 'pending') return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const state = await getPhoneVerificationState();
        if (!active) return;
        if (state.status === 'verified') {
          setPhase('verified');
          onVerifiedRef.current?.();
        } else if (state.status === 'expired') {
          setPhase('expired');
        }
      } catch {
        // Falha momentânea: tenta de novo no próximo ciclo.
      }
    }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [phase]);

  if (phase === 'loading') {
    return <p className="text-sm text-muted-foreground">Gerando código...</p>;
  }

  if (phase === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">{error}</p>
        <Button type="button" variant="outline" onClick={() => void generate()}>
          Tentar de novo
        </Button>
      </div>
    );
  }

  if (phase === 'verified') {
    return (
      <div className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900">
        WhatsApp verificado! Já enviamos uma mensagem de boas-vindas para você.
      </div>
    );
  }

  if (!challenge) return null;

  if (phase === 'expired') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          O código expirou. Gere um novo e envie ao bot.
        </p>
        <Button type="button" onClick={() => void generate()}>
          Gerar novo código
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
        <li>
          Use o WhatsApp do número <strong className="text-foreground">{challenge.phone}</strong>.
        </li>
        <li>Envie a mensagem com o código abaixo para o nosso WhatsApp.</li>
        <li>Pronto: esta tela avança sozinha quando recebermos o código.</li>
      </ol>

      <div className="flex flex-col gap-5 md:flex-row md:items-center md:gap-8">
        <div className="flex-1 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Seu código</p>
            <p className="font-mono text-3xl font-semibold tracking-[0.3em]">{challenge.code}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Expira em {formatRemaining(remaining)}
            </p>
          </div>

          {challenge.waLink ? (
            <Button asChild className="w-full md:w-auto">
              <a href={challenge.waLink} target="_blank" rel="noopener noreferrer">
                Verificar pelo WhatsApp
              </a>
            </Button>
          ) : null}

          {challenge.botNumber ? (
            <p className="text-sm text-muted-foreground">
              Nosso WhatsApp:{' '}
              <span className="font-medium text-foreground">
                {formatBotNumber(challenge.botNumber)}
              </span>
              . Salve o contato para registrar seus lançamentos depois.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Envie a mensagem &quot;{challenge.message}&quot; para o WhatsApp do Financial Vellun.
            </p>
          )}

          <Button
            type="button"
            variant="link"
            className="h-auto px-0 text-sm"
            onClick={() => void generate()}
          >
            Gerar novo código
          </Button>
        </div>

        {challenge.waLink ? (
          <div className="hidden flex-col items-center gap-2 md:flex">
            <div className="rounded-lg border bg-white p-3">
              <QRCodeSVG value={challenge.waLink} size={176} level="M" />
            </div>
            <p className="max-w-[12rem] text-center text-xs text-muted-foreground">
              Leia com a câmera do celular para abrir a conversa com a mensagem pronta.
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
