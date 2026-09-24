'use client';
import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import type { FinancialResources } from '@/hooks/useFinancialResources';
import type { ResourceSelection } from '@/hooks/useResourceFilter';

interface Props {
  resources: FinancialResources | null;
  value: ResourceSelection;
  onChange: (next: ResourceSelection) => void;
}

function toggle(list: string[], id: string) {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/** Rótulo curto do recorte para o botão. */
function describe(resources: FinancialResources | null, value: ResourceSelection) {
  const count = value.accountIds.length + value.cardIds.length;
  if (count === 0) return 'Todas as contas e cartões';
  if (count === 1 && resources) {
    const account = resources.accounts.find((a) => a.id === value.accountIds[0]);
    const card = resources.cards.find((c) => c.id === value.cardIds[0]);
    return account?.name ?? card?.name ?? '1 selecionado';
  }
  return `${count} selecionados`;
}

/**
 * Filtro por recurso: botão que abre um diálogo com contas e cartões em
 * checkboxes. Nenhum marcado (ou "Todos") = consolidado. As escolhas só valem
 * ao aplicar, para não disparar uma consulta a cada clique.
 */
export function ResourceFilter({ resources, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ResourceSelection>(value);

  const openDialog = () => {
    setDraft(value);
    setOpen(true);
  };
  const apply = (next: ResourceSelection) => {
    onChange(next);
    setOpen(false);
  };

  const accounts = resources?.accounts ?? [];
  const cards = resources?.cards ?? [];
  const nothingSelected = draft.accountIds.length === 0 && draft.cardIds.length === 0;

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={openDialog}
        className="h-9 max-w-full justify-start gap-2"
        aria-haspopup="dialog"
      >
        <SlidersHorizontal className="h-4 w-4 shrink-0" />
        <span className="truncate">{describe(resources, value)}</span>
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="Contas e cartões">
        <div className="space-y-4">
          <label className="flex min-h-10 items-center gap-3 rounded-md border px-3 text-sm font-medium">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={nothingSelected}
              onChange={() => setDraft({ accountIds: [], cardIds: [] })}
            />
            Todos (consolidado)
          </label>

          {[
            {
              title: 'Contas',
              items: accounts.map((a) => ({ id: a.id, name: a.name, archived: false })),
              key: 'accountIds' as const,
            },
            {
              title: 'Cartões',
              items: cards.map((c) => ({ id: c.id, name: c.name, archived: !c.isActive })),
              key: 'cardIds' as const,
            },
          ]
            .filter((group) => group.items.length > 0)
            .map((group) => (
              <fieldset key={group.key} className="space-y-1">
                <legend className="mb-1 text-xs font-medium uppercase text-muted-foreground">
                  {group.title}
                </legend>
                {group.items.map((item) => (
                  <label
                    key={item.id}
                    className="flex min-h-10 items-center gap-3 rounded-md px-3 text-sm hover:bg-muted"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={draft[group.key].includes(item.id)}
                      onChange={() =>
                        setDraft((d) => ({ ...d, [group.key]: toggle(d[group.key], item.id) }))
                      }
                    />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.archived && (
                      <span className="text-xs text-muted-foreground">arquivado</span>
                    )}
                  </label>
                ))}
              </fieldset>
            ))}

          <div className="flex gap-2 pt-2">
            <Button type="button" className="flex-1" onClick={() => apply(draft)}>
              Aplicar
            </Button>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
