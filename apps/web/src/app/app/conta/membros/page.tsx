'use client';
import { useState } from 'react';
import Link from 'next/link';
import { Copy, Trash2, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { useAuth } from '@/contexts/auth-context';
import { useMembers } from '@/hooks/useMembers';
import { inviteMember, revokeInvite, removeMember } from '@/lib/members';

function formatDate(v: string) {
  return new Date(v).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export default function MembrosPage() {
  const { user } = useAuth();
  const { data, invites, loading, refetch } = useMembers();
  const toast = useToast();
  const confirm = useConfirm();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isOwner = !user?.householdOwnerId;

  const handleInvite = async () => {
    if (!email.trim()) return;
    setSubmitting(true);
    try {
      await inviteMember(email.trim());
      toast.success('Convite enviado! Copie o link abaixo e envie para a pessoa.');
      setEmail('');
      setInviteOpen(false);
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao criar convite');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyLink = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copiado!');
    } catch {
      toast.error('Não foi possível copiar o link');
    }
  };

  const handleRevokeInvite = async (id: string) => {
    const ok = await confirm({
      title: 'Cancelar convite',
      description: 'Esse link deixará de funcionar.',
      confirmText: 'Cancelar convite',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await revokeInvite(id);
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao cancelar convite');
    }
  };

  const handleRemoveMember = async (id: string, name: string) => {
    const ok = await confirm({
      title: 'Remover membro',
      description: `${name} perderá o acesso aos dados compartilhados.`,
      confirmText: 'Remover',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await removeMember(id);
      toast.success('Membro removido.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao remover membro');
    }
  };

  const totalPeople = (data?.members.length ?? 0) + 1;
  const canInvite = isOwner && !!data && totalPeople + invites.length < data.maxMembers;
  const planTooSmall = isOwner && !!data && data.maxMembers <= 1;

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Membros</h1>
          <p className="text-sm text-muted-foreground">
            {isOwner
              ? 'Compartilhe suas finanças com quem faz parte do seu plano.'
              : 'Você faz parte de um plano compartilhado.'}
          </p>
        </div>
        {canInvite && (
          <Button size="sm" onClick={() => setInviteOpen(true)}>
            <UserPlus className="mr-1 h-4 w-4" />
            Convidar membro
          </Button>
        )}
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
      ) : (
        <>
          {planTooSmall && (
            <Card className="rounded-2xl border-dashed">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 p-5">
                <p className="text-sm text-muted-foreground">
                  Seu plano atual não permite convidar outras pessoas. Mude para o plano Duo para
                  organizar as finanças em dupla.
                </p>
                <Button asChild size="sm" variant="outline">
                  <Link href="/app/conta/assinatura">Ver planos</Link>
                </Button>
              </CardContent>
            </Card>
          )}

          <Card className="rounded-2xl">
            <CardContent className="divide-y p-0">
              {data?.owner && (
                <div className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium">
                      {data.owner.name}
                      {data.owner.id === user?.id && <span className="text-muted-foreground"> (você)</span>}
                    </p>
                    <p className="text-sm text-muted-foreground">{data.owner.email}</p>
                  </div>
                  <Badge className="bg-primary/10 text-primary">Dono do plano</Badge>
                </div>
              )}
              {data?.members.map((member) => (
                <div key={member.id} className="flex items-center justify-between gap-3 p-4">
                  <div>
                    <p className="font-medium">
                      {member.name}
                      {member.id === user?.id && <span className="text-muted-foreground"> (você)</span>}
                    </p>
                    <p className="text-sm text-muted-foreground">{member.email}</p>
                  </div>
                  {isOwner && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive"
                      onClick={() => handleRemoveMember(member.id, member.name)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </div>
              ))}
              {(!data || data.members.length === 0) && (
                <div className="p-4 text-sm text-muted-foreground">
                  {isOwner ? 'Ninguém convidado ainda.' : ''}
                </div>
              )}
            </CardContent>
          </Card>

          {isOwner && invites.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">Convites pendentes</p>
              <Card className="rounded-2xl">
                <CardContent className="divide-y p-0">
                  {invites.map((invite) => (
                    <div key={invite.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                      <div>
                        <p className="font-medium">{invite.email}</p>
                        <p className="text-xs text-muted-foreground">
                          Expira em {formatDate(invite.expiresAt)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {invite.inviteUrl && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => handleCopyLink(invite.inviteUrl!)}
                          >
                            <Copy className="mr-1 h-3.5 w-3.5" />
                            Copiar link
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          onClick={() => handleRevokeInvite(invite.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}

      <Dialog open={inviteOpen} onClose={() => setInviteOpen(false)} title="Convidar membro">
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Email da pessoa</Label>
            <Input
              id="invite-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="nome@exemplo.com"
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Você vai receber um link para compartilhar com essa pessoa. Ela cria a própria senha e
            passa a ver e lançar junto com você.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setInviteOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={handleInvite} disabled={submitting || !email.trim()}>
              Enviar convite
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
