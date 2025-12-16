// @ts-nocheck
declare module './_common.js' {
  export function tokenHosts(env: string | undefined): { tokenHost: string; apiHost: string };
  export function accessTokenFromRefresh(refreshToken: string, scopes?: string[]): Promise<{ access_token: string; expires_in: number } & Record<string, any>>;
  export function appAccessToken(scopes: string[]): Promise<{ access_token: string; expires_in: number } & Record<string, any>>;
}
