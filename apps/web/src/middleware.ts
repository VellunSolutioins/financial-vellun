import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/', '/login', '/cadastro'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith('/_next');

  // A sessão é marcada pelo refresh_token (7 dias). O access_token (15 min) é
  // de curta duração e renovado pelo api-client; não pode gatear a navegação,
  // senão o usuário cai no login a cada troca de menu após 15 min.
  const hasSession = Boolean(req.cookies.get('refresh_token')?.value);

  if (!isPublic && !hasSession) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (hasSession && (pathname === '/login' || pathname === '/cadastro')) {
    return NextResponse.redirect(new URL('/app/pessoal/dashboard', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
