import type { AuthManager } from '../auth/AuthManager.js';

export interface RequestOptions extends RequestInit {
  _retry?: boolean;
}

export function createAuthInterceptor(authManager: AuthManager) {
  return async (url: string, options: RequestOptions = {}): Promise<Response> => {
    // Inject token
    let token: string | null = null;
    try {
      token = await authManager.getValidToken();
    } catch {
      // Not authenticated — proceed without token
    }

    const headers = new Headers(options.headers);
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const response = await fetch(url, { ...options, headers });

    // Handle 401 — try refresh once
    if (response.status === 401 && !options._retry) {
      try {
        const newToken = await authManager.getValidToken();
        headers.set('Authorization', `Bearer ${newToken}`);
        return fetch(url, { ...options, headers, _retry: true } as RequestOptions);
      } catch {
        return response;
      }
    }

    return response;
  };
}
