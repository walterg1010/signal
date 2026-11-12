import { randomUUID } from "node:crypto";

const COOKIE_NAME = "signal_supporter";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readSupporter(request: Request): string | null {
  const cookie = request.headers.get("cookie")?.split(";")
    .map(part => part.trim()).find(part => part.startsWith(`${COOKIE_NAME}=`));
  const value = cookie?.slice(COOKIE_NAME.length + 1);
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

export function getSupporter(request: Request): { id: string; cookie: string | null } {
  const existing = readSupporter(request);
  if (existing) return { id: existing, cookie: null };
  const id = randomUUID();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return {
    id,
    cookie: `${COOKIE_NAME}=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`,
  };
}
