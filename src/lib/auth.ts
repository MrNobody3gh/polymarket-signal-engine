/** Cron endpoints accept Vercel's `Authorization: Bearer $CRON_SECRET` or `?secret=`. */
export function cronAuthorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET; if (!secret) return process.env.NODE_ENV !== "production";
  const auth = req.headers.get("authorization") ?? ""; const url = new URL(req.url);
  return auth === `Bearer ${secret}` || url.searchParams.get("secret") === secret;
}
