import { decodeJwt } from 'jose';
import type { JWTClaims, UserProfile } from './types.js';

export function decodeToken(token: string): JWTClaims | null {
  try {
    const claims = decodeJwt(token) as JWTClaims;
    return claims;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string, bufferSeconds = 60): boolean {
  const claims = decodeToken(token);
  if (!claims) return true;
  const expiresAt = claims.exp * 1000;
  return Date.now() > expiresAt - bufferSeconds * 1000;
}

export function extractUserProfile(token: string): UserProfile | null {
  const claims = decodeToken(token);
  if (!claims) return null;
  return {
    sub: claims.sub,
    email: claims.email ?? '',
    name: claims.name,
  };
}

export function extractTier(token: string): string | undefined {
  const claims = decodeToken(token);
  return claims?.tier;
}
