import { Suspense } from 'react';

import { InvoicesView } from '@/components/credit-cards/InvoicesView';

export default function FaturasPage() {
  // `useSearchParams` (cartão e mês na URL) precisa de Suspense no build do Next.
  return (
    <Suspense>
      <InvoicesView />
    </Suspense>
  );
}
