import type { Metadata } from 'next';
import { LegalPage, type LegalSection } from '@/components/marketing/legal-page';

export const metadata: Metadata = {
  title: 'Política de Privacidade — Financial Vellun',
  description: 'Como o Financial Vellun coleta, usa, compartilha e protege os seus dados.',
};

const SECTIONS: LegalSection[] = [
  {
    title: 'Coleta de informações',
    paragraphs: [
      'Coletamos os dados que você informa ao criar e usar a sua conta: nome, e-mail, celular, endereço e CPF ou CNPJ.',
      'Também tratamos as informações financeiras que você registra, como contas, cartões, categorias e lançamentos, e as mensagens que você envia ao nosso WhatsApp para registrá-los, em texto, áudio ou imagem de comprovante.',
      'Ao contratar um plano, tratamos os dados da assinatura e dos pagamentos, que são processados por um prestador especializado.',
    ],
  },
  {
    title: 'Uso das informações',
    paragraphs: [
      'Utilizamos os dados para criar e manter a sua conta, registrar os lançamentos a partir das suas mensagens, exibir o seu painel financeiro, processar a sua assinatura, falar com você sobre a sua conta e proteger o serviço contra uso indevido.',
      'As mensagens enviadas pelo WhatsApp são interpretadas de forma automatizada para identificar o valor, a data, a categoria e a conta de cada lançamento.',
    ],
  },
  {
    title: 'Compartilhamento de dados',
    paragraphs: [
      'Não vendemos dados pessoais.',
      'O compartilhamento ocorre apenas quando necessário para a execução do serviço, com os prestadores que nos ajudam a operá-lo: o provedor de mensagens do WhatsApp, o serviço de inteligência artificial que interpreta as suas mensagens, o processador de pagamentos e a infraestrutura de hospedagem e monitoramento. Também pode ocorrer para cumprimento legal ou proteção de direitos.',
    ],
  },
  {
    title: 'Armazenamento e segurança',
    paragraphs: [
      'Adotamos medidas técnicas e organizacionais para proteger os dados contra acesso não autorizado, perda ou alteração indevida. A sua senha não é armazenada em formato legível.',
      'O texto das mensagens enviadas pelo WhatsApp é removido periodicamente dos nossos registros. Os lançamentos e os demais dados da conta ficam guardados enquanto ela existir ou pelo prazo exigido por lei.',
    ],
  },
  {
    title: 'Direitos do titular',
    paragraphs: [
      'Você pode solicitar acesso, correção, exclusão ou portabilidade dos seus dados, observadas as obrigações legais aplicáveis.',
      'Parte dos dados cadastrais pode ser corrigida diretamente em Minha Conta, dentro do aplicativo.',
    ],
  },
  {
    title: 'Contato',
    paragraphs: [
      'Para dúvidas sobre privacidade, entre em contato com o Financial Vellun pelos canais oficiais de atendimento.',
    ],
  },
];

export default function PrivacidadePage() {
  return (
    <LegalPage
      title="Política de Privacidade"
      updatedAt="10 de outubro de 2026"
      sections={SECTIONS}
    />
  );
}
