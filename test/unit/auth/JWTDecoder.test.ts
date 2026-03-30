import { describe, it, expect } from 'vitest';
import {
  decodeToken,
  isTokenExpired,
  extractUserProfile,
  extractTier,
} from '../../../src/auth/JWTDecoder.js';

function makeTestToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.fakesignature`;
}

describe('JWTDecoder', () => {
  it('decodes a valid JWT payload', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeTestToken({
      sub: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      tier: 'pro',
      exp,
      iat: 0,
      iss: 'https://auth.example.com',
      aud: 'epam-cli',
    });
    const claims = decodeToken(token);
    expect(claims?.sub).toBe('user-123');
    expect(claims?.email).toBe('test@example.com');
    expect(claims?.tier).toBe('pro');
  });

  it('returns null for malformed token', () => {
    expect(decodeToken('not-a-jwt')).toBeNull();
    expect(decodeToken('')).toBeNull();
  });

  it('isTokenExpired returns false for valid token', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeTestToken({ sub: 'u', exp, iat: 0, iss: 'x', aud: 'y' });
    expect(isTokenExpired(token)).toBe(false);
  });

  it('isTokenExpired returns true for expired token', () => {
    const exp = Math.floor(Date.now() / 1000) - 3600;
    const token = makeTestToken({ sub: 'u', exp, iat: 0, iss: 'x', aud: 'y' });
    expect(isTokenExpired(token)).toBe(true);
  });

  it('isTokenExpired respects buffer seconds', () => {
    const exp = Math.floor(Date.now() / 1000) + 30;
    const token = makeTestToken({ sub: 'u', exp, iat: 0, iss: 'x', aud: 'y' });
    expect(isTokenExpired(token, 60)).toBe(true);
    expect(isTokenExpired(token, 10)).toBe(false);
  });

  it('extractTier returns tier claim', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeTestToken({ sub: 'u', tier: 'enterprise', exp, iat: 0, iss: 'x', aud: 'y' });
    expect(extractTier(token)).toBe('enterprise');
  });

  it('extractTier returns undefined when no tier claim', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = makeTestToken({ sub: 'u', exp, iat: 0, iss: 'x', aud: 'y' });
    expect(extractTier(token)).toBeUndefined();
  });
});
