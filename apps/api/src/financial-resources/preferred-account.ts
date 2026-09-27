import { Prisma } from '@prisma/client';

/**
 * Desliga a preferência de quem apontava para a conta (ou para a conta interna
 * do cartão). Chamado ao desativar conta ou arquivar cartão: um recurso que não
 * recebe lançamento não pode vir pré-selecionado.
 */
export function clearPreferredAccount(
  client: Pick<Prisma.TransactionClient, 'user'>,
  accountId: string,
) {
  return client.user.updateMany({
    where: { preferredAccountId: accountId },
    data: { preferredAccountId: null },
  });
}
