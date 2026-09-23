'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { WhatsappVerification } from '@/components/whatsapp/whatsapp-verification';
import { useAuth } from '@/contexts/auth-context';

/**
 * Passo seguinte ao cadastro: vincular o WhatsApp provando a posse do número.
 * Também é o destino do aviso exibido enquanto o número não é verificado.
 */
export default function VerificarWhatsappPage() {
  const { user, setUser } = useAuth();
  // Verificado agora, nesta tela: mantém a confirmação do próprio componente.
  const [justVerified, setJustVerified] = useState(false);
  if (!user) return null;

  const verified = user.whatsappVerified || justVerified;

  const dashboard =
    user.profileType === 'business' ? '/app/empresa/dashboard' : '/app/pessoal/dashboard';

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl sm:text-2xl">Ative seu WhatsApp</CardTitle>
          <CardDescription>
            É pelo WhatsApp que você registra lançamentos conversando com o Financial Vellun. Para
            ligar o número à sua conta, precisamos confirmar que ele é seu.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {user.whatsappVerified && !justVerified ? (
            <div className="rounded-md border border-green-300 bg-green-50 px-4 py-3 text-sm text-green-900">
              Seu WhatsApp já está verificado. Para trocar o número, use Minha Conta.
            </div>
          ) : (
            <WhatsappVerification
              onVerified={() => {
                setJustVerified(true);
                setUser({ ...user, whatsappVerified: true });
              }}
            />
          )}

          <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:justify-end">
            {verified ? (
              <Button asChild className="w-full sm:w-auto">
                <Link href={dashboard}>Ir para o painel</Link>
              </Button>
            ) : (
              <Button asChild variant="ghost" className="w-full sm:w-auto">
                <Link href={dashboard}>Fazer isso depois</Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
