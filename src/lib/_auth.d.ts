// @ts-nocheck
/* eslint-disable */
declare module './_auth.js' {
  import type { HandlerEvent } from '@netlify/functions';
  export function getBearerToken(event: HandlerEvent): string | null;
  export function getJwtSubUnverified(event: HandlerEvent): string | null;
  export function requireAuthVerified(event: HandlerEvent): Promise<{ sub: string; claims: Record<string, any> } | null>;
  export function requireAuth(event: HandlerEvent): Promise<{ sub: string; email?: string; name?: string } | null>;
  export function userScopedKey(sub: string | null, key: string): string;
  export function json(body: any, status?: number): { statusCode: number; headers: Record<string, string>; body: string };
}
