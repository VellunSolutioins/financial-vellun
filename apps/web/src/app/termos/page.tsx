import type { Metadata } from 'next';
import { LegalPage, type LegalSection } from '@/components/marketing/legal-page';

export const metadata: Metadata = {
  title: 'Termos de Serviço — Financial Vellun',
  description: 'Condições de uso do site e do aplicativo Financial Vellun.',
};

const SECTIONS: LegalSection[] = [
  {
    title: 'Objeto',
    paragraphs: [
      'Estes termos regulam o uso do site e do aplicativo Financial Vellun, um serviço de controle financeiro com registro de lançamentos por mensagens no WhatsApp.',
    ],
  },
  {
    title: 'Uso do serviço',
    paragraphs: [
      'Para usar o serviço, você cria uma conta, informa dados verdadeiros e verifica o número de WhatsApp que será vinculado a ela. Você é responsável por manter a sua senha em sigilo e pelo que for registrado a partir do número verificado.',
      'O acesso às funcionalidades depende de uma assinatura ativa, contratada dentro do aplicativo.',
      'Você se compromete a utilizar o serviço de forma lícita, sem violar direitos de terceiros ou comprometer a segurança da plataforma.',
    ],
  },
  {
    title: 'Propriedade intelectual',
    paragraphs: [
      'Conteúdos, marcas, textos e materiais do Financial Vellun são protegidos por direitos de propriedade intelectual e não podem ser reproduzidos sem autorização.',
    ],
  },
  {
    title: 'Limitação de responsabilidade',
    paragraphs: [
      'O Financial Vellun é uma ferramenta de organização e não presta consultoria financeira, contábil ou de investimentos.',
      'As mensagens são interpretadas de forma automatizada, e o resultado pode conter erros. Confira os lançamentos no aplicativo e corrija o que for necessário.',
      'O Financial Vellun não se responsabiliza por indisponibilidades temporárias, por falhas de conexão ou de serviços de terceiros, como o WhatsApp, nem pelo uso inadequado da sua conta por terceiros.',
    ],
  },
  {
    title: 'Alterações dos termos',
    paragraphs: [
      'Estes termos podem ser atualizados a qualquer momento. A versão vigente será sempre publicada nesta página.',
    ],
  },
  {
    title: 'Contato',
    paragraphs: [
      'Dúvidas sobre estes termos podem ser enviadas pelos canais oficiais de atendimento do Financial Vellun.',
    ],
  },
];

export default function TermosPage() {
  return (
    <LegalPage title="Termos de Serviço" updatedAt="10 de outubro de 2026" sections={SECTIONS} />
  );
}
