/**
 * Cartão em configuração pendente: sem fechamento, vencimento ou início do
 * controle. Cartões legados ficam assim até o usuário configurá-los — nenhuma
 * data é inventada.
 */
export function cardNeedsSetup(card: {
  closingDay: number | null;
  dueDay: number | null;
  invoiceTrackingStart: Date | null;
}): boolean {
  return card.closingDay === null || card.dueDay === null || card.invoiceTrackingStart === null;
}
