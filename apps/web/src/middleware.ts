import { NextResponse } from 'next/server';

// Gating de assinatura é feito pela API (fonte de verdade): o guard retorna
// 403 SUBSCRIPTION_REQUIRED e o api-client redireciona para /app/conta/assinatura.
// O middleware permanece no-op para não duplicar regra no edge (o cookie é
// HttpOnly e não expõe o estado comercial). Mantido como ponto de extensão.
export function middleware() {
  return NextResponse.next();
}
