import { FeatureFlagsService } from './feature-flags.service';

function setup(rows: { key: string; enabled: boolean }[]) {
  const prisma = {
    featureFlag: {
      findMany: jest.fn().mockResolvedValue(rows),
      findUnique: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          Promise.resolve(rows.find((row) => row.key === where.key) ?? null),
        ),
    },
  } as any;
  return new FeatureFlagsService(prisma);
}

describe('FeatureFlagsService', () => {
  it('usa o default do catálogo quando ninguém mexeu na flag', async () => {
    // Sem linha no banco é o estado de todo deploy novo: nada pode sumir do app só por subir a versão.
    const service = setup([]);
    await expect(service.getAll()).resolves.toEqual({ agenda: true, notes: true });
    await expect(service.isEnabled('notes')).resolves.toBe(true);
  });

  it('a linha do banco vale mais que o default', async () => {
    const service = setup([{ key: 'notes', enabled: false }]);
    await expect(service.getAll()).resolves.toEqual({ agenda: true, notes: false });
    await expect(service.isEnabled('notes')).resolves.toBe(false);
    await expect(service.isEnabled('agenda')).resolves.toBe(true);
  });

  it('ignora linha de flag que saiu do catálogo', async () => {
    // Remover uma flag do código não pode vazar uma chave desconhecida para o app.
    const service = setup([{ key: 'legada', enabled: false }]);
    await expect(service.getAll()).resolves.toEqual({ agenda: true, notes: true });
  });
});
