import { UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';

import { UsersService } from './users.service';

const TEST_PASSWORD = 'p'.repeat(12);

async function createService() {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'user-1',
        email: 'joao@example.com',
        passwordHash: await bcrypt.hash(TEST_PASSWORD, 4),
      }),
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ id: 'user-1', email: 'novo@example.com' }),
    },
    passwordResetToken: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(),
  };
  // A transação recebe o próprio mock como cliente.
  prisma.$transaction.mockImplementation((callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const sessions = { revokeAllForUser: jest.fn().mockResolvedValue(2) };
  const securityEvents = { record: jest.fn().mockResolvedValue(undefined) };
  const notifier = { notify: jest.fn() };
  const service = new UsersService(
    prisma as any,
    sessions as any,
    securityEvents as any,
    notifier as any,
  );
  return { prisma, sessions, securityEvents, notifier, service };
}

describe('UsersService', () => {
  describe('updatePassword', () => {
    it('encerra as demais sessões e mantém a atual', async () => {
      const { prisma, sessions, service } = await createService();

      await service.updatePassword('user-1', 'session-atual', {
        currentPassword: TEST_PASSWORD,
        newPassword: 'n'.repeat(12),
      });

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith('user-1', 'session-atual', prisma);
    });

    it('invalida links de redefinição pendentes junto com a troca', async () => {
      const { prisma, service } = await createService();

      await service.updatePassword('user-1', 'session-atual', {
        currentPassword: TEST_PASSWORD,
        newPassword: 'n'.repeat(12),
      });

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });

    it('registra a troca na trilha da conta, com a origem da requisição', async () => {
      const { securityEvents, service } = await createService();

      await service.updatePassword(
        'user-1',
        'session-atual',
        { currentPassword: TEST_PASSWORD, newPassword: 'n'.repeat(12) },
        { ip: '203.0.113.10', userAgent: 'jest' },
      );

      expect(securityEvents.record).toHaveBeenCalledWith('user-1', 'password_changed', {
        ip: '203.0.113.10',
        userAgent: 'jest',
        metadata: { sessoesEncerradas: 2 },
      });
    });

    it('avisa por e-mail que a senha mudou', async () => {
      const { notifier, service } = await createService();

      await service.updatePassword('user-1', 'session-atual', {
        currentPassword: TEST_PASSWORD,
        newPassword: 'n'.repeat(12),
      });

      expect(notifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1', email: 'joao@example.com' }),
        'change',
      );
    });

    it('senha atual errada não troca nem revoga', async () => {
      const { prisma, sessions, notifier, service } = await createService();

      await expect(
        service.updatePassword('user-1', 'session-atual', {
          currentPassword: 'x'.repeat(12),
          newPassword: 'n'.repeat(12),
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(notifier.notify).not.toHaveBeenCalled();
    });
  });

  describe('updateUser', () => {
    it('trocar o e-mail sem a senha atual é recusado', async () => {
      const { prisma, service } = await createService();

      await expect(
        service.updateUser('user-1', { email: 'novo@example.com' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('troca o e-mail normalizado com a senha atual', async () => {
      const { prisma, service } = await createService();

      await service.updateUser('user-1', {
        email: ' Novo@Example.com ',
        currentPassword: TEST_PASSWORD,
      });

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: 'novo@example.com' }) }),
      );
    });

    it('trocar o e-mail invalida links de redefinição pendentes', async () => {
      const { prisma, service } = await createService();

      await service.updateUser('user-1', {
        email: 'novo@example.com',
        currentPassword: TEST_PASSWORD,
      });

      expect(prisma.passwordResetToken.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'user-1' },
      });
    });

    it('editar só o nome mantém os links de redefinição', async () => {
      const { prisma, service } = await createService();

      await service.updateUser('user-1', { name: 'Joao' });

      expect(prisma.passwordResetToken.deleteMany).not.toHaveBeenCalled();
    });

    it('registra a troca de e-mail mascarado na trilha', async () => {
      const { securityEvents, service } = await createService();

      await service.updateUser('user-1', {
        email: 'novo@example.com',
        currentPassword: TEST_PASSWORD,
      });

      expect(securityEvents.record).toHaveBeenCalledWith('user-1', 'email_changed', {
        metadata: { de: 'j***@example.com', para: 'n***@example.com' },
      });
    });

    it('reenviar o mesmo e-mail (com outra caixa) não pede senha', async () => {
      const { prisma, service } = await createService();

      await service.updateUser('user-1', { email: 'JOAO@example.com', name: 'Joao' });

      expect(prisma.user.update).toHaveBeenCalled();
    });

    it('não altera o telefone: ele só muda pela verificação', async () => {
      const { prisma, service } = await createService();

      await service.updateUser('user-1', { name: 'Joao' });

      const data = prisma.user.update.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('phone');
    });
  });
});
