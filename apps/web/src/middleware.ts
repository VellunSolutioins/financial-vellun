import { NextRequest, NextResponse } from 'next/server';

const PUBLIC_PATHS = ['/', '/login', '/cadastro'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p) || pathname.startsWith('/_next');
  const accessToken = req.cookies.get('access_token')?.value;

  if (!isPublic && !accessToken) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  if (accessToken && (pathname === '/login' || pathname === '/cadastro')) {
    return NextResponse.redirect(new URL('/app/pessoal/dashboard', req.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico).*)'],
};
