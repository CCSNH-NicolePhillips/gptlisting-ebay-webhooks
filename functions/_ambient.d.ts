// Ambient declarations to help TypeScript resolve NodeNext-style relative imports
// in the functions/ directory during Netlify builds.
declare module './_auth.js' {
  import type { HandlerEvent } from '@netlify/functions';
  export function getBearerToken(event: HandlerEvent): string | null;
  export function getJwtSubUnverified(event: HandlerEvent): string | null;
  export function requireAuthVerified(event: HandlerEvent): Promise<{ sub: string; claims: Record<string, any> } | null>;
  export function requireAuth(event: HandlerEvent): Promise<{ sub: string; email?: string; name?: string } | null>;
  export function userScopedKey(sub: string | null, key: string): string;
  export function json(body: any, status?: number): { statusCode: number; headers: Record<string, string>; body: string };
}

declare module './_common.js' {
  export function tokenHosts(env: string | undefined): { tokenHost: string; apiHost: string };
  export function accessTokenFromRefresh(refreshToken: string, scopes?: string[]): Promise<{ access_token: string; expires_in: number } & Record<string, any>>;
  export function appAccessToken(scopes: string[]): Promise<{ access_token: string; expires_in: number } & Record<string, any>>;
}

declare module './_blobs.js' {
  export function tokensStore(): any;
  export function cacheStore(): any;
}
