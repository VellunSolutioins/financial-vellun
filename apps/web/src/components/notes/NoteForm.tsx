'use client';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/components/ui/toast';
import type { Note } from '@/hooks/useNotes';
import { cn } from '@/lib/utils';

const schema = z.object({
  title: z.string().min(1, 'Título obrigatório'),
  content: z.string().min(1, 'Escreva sua anotação'),
});
type FormData = z.infer<typeof schema>;

interface Props {
  note?: Note;
  onSuccess: () => void;
  onCancel: () => void;
}

export function NoteForm({ note, onSuccess, onCancel }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: note?.title ?? '',
      content: note?.content ?? '',
    },
  });

  const onSubmit = async (data: FormData) => {
    setSubmitting(true);
    try {
      if (note) {
        await apiClient.patch(`/notes/${note.id}`, data);
        toast.success('Anotação atualizada com sucesso.');
      } else {
        await apiClient.post('/notes', data);
        toast.success('Anotação criada com sucesso.');
      }
      onSuccess();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : 'Erro ao salvar anotação');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-1">
        <Label>Título</Label>
        <Input placeholder="Ex: Ideia para reduzir gastos" {...register('title')} />
        {errors.title && <p className="text-xs text-destructive">{errors.title.message}</p>}
      </div>
      <div className="space-y-1">
        <Label>Anotação</Label>
        <textarea
          rows={6}
          placeholder="Escreva sua anotação, insight ou ideia..."
          {...register('content')}
          className={cn(
            'flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          )}
        />
        {errors.content && <p className="text-xs text-destructive">{errors.content.message}</p>}
      </div>
      <div className="flex gap-2 pt-2">
        <Button type="submit" disabled={submitting} className="flex-1">
          {submitting ? 'Salvando...' : note ? 'Salvar alterações' : 'Criar anotação'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Fechar
        </Button>
      </div>
    </form>
  );
}
