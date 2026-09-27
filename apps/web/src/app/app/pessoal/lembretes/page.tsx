import { redirect } from 'next/navigation';
export default async function LembretesPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { month } = await searchParams;
  redirect('/app/pessoal/agenda' + (month ? '?month=' + encodeURIComponent(month) : ''));
}
