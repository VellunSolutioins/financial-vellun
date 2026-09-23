'use client';
import { useState } from 'react';
import { Plus, Pin } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { NoteForm } from '@/components/notes/NoteForm';
import { useNotes, type Note } from '@/hooks/useNotes';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import { useConfirm } from '@/components/ui/confirm';
import { cn } from '@/lib/utils';

function formatDate(v: string) {
  return new Date(v).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function AnotacoesPage() {
  const { data, loading, refetch } = useNotes();
  const [formOpen, setFormOpen] = useState(false);
  const [editingNote, setEditingNote] = useState<Note | undefined>();
  const toast = useToast();
  const confirm = useConfirm();

  const openNew = () => {
    setEditingNote(undefined);
    setFormOpen(true);
  };
  const openEdit = (note: Note) => {
    setEditingNote(note);
    setFormOpen(true);
  };
  const closeForm = () => setFormOpen(false);
  const handleFormSuccess = () => {
    closeForm();
    void refetch();
  };

  const handleTogglePin = async (note: Note) => {
    try {
      await apiClient.patch(`/notes/${note.id}/pin`, {});
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao fixar anotação');
    }
  };

  const handleDelete = async (note: Note) => {
    const ok = await confirm({
      title: 'Excluir anotação',
      description: `Excluir "${note.title}"?`,
      confirmText: 'Excluir',
      variant: 'destructive',
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/notes/${note.id}`);
      toast.success('Anotação excluída.');
      void refetch();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao excluir anotação');
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">Anotações</h1>
          <p className="text-sm text-muted-foreground">Insights, ideias e lembretes rápidos.</p>
        </div>
        <Button size="sm" onClick={openNew}>
          <Plus className="mr-1 h-4 w-4" />
          Nova anotação
        </Button>
      </div>

      {loading ? (
        <div className="p-10 text-center text-sm text-muted-foreground">Carregando...</div>
      ) : data.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            Nenhuma anotação ainda.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.map((note) => (
            <Card
              key={note.id}
              className={cn('cursor-pointer rounded-2xl', note.isPinned && 'ring-2 ring-amber-400')}
              onClick={() => openEdit(note)}
            >
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate font-medium">{note.title}</p>
                  <button
                    type="button"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void handleTogglePin(note);
                    }}
                    aria-label={note.isPinned ? 'Desafixar' : 'Fixar'}
                    className="shrink-0"
                  >
                    <Pin
                      className={cn(
                        'h-4 w-4',
                        note.isPinned ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground',
                      )}
                    />
                  </button>
                </div>
                <p className="line-clamp-4 whitespace-pre-wrap text-sm text-muted-foreground">
                  {note.content}
                </p>
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-xs text-muted-foreground">
                    {formatDate(note.createdAt)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-destructive"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      void handleDelete(note);
                    }}
                  >
                    Excluir
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog
        open={formOpen}
        onClose={closeForm}
        title={editingNote ? 'Editar anotação' : 'Nova anotação'}
      >
        <NoteForm note={editingNote} onSuccess={handleFormSuccess} onCancel={closeForm} />
      </Dialog>
    </div>
  );
}
