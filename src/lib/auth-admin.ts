const ADMIN_TOKEN = (process.env.ADMIN_API_TOKEN || "").trim();

export function requireAdminAuth(authHeader?: string): void {
  if (!ADMIN_TOKEN) return;
  if (!authHeader?.startsWith("Bearer ")) throw new Error("unauthorized");
  const token = authHeader.slice(7).trim();
  if (token !== ADMIN_TOKEN) throw new Error("unauthorized");
}
