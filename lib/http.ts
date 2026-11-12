export function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
  });
}

export function isLocalRequest(request: Request): boolean {
  // Next can normalize Request.url to localhost. Use the actual Host header
  // and restrict it to loopback so another website cannot write to this app.
  const expectedOrigin = new URL(request.url);
  expectedOrigin.host = request.headers.get("host") ?? expectedOrigin.host;
  const origin = request.headers.get("origin");
  return ["localhost", "127.0.0.1", "[::1]"].includes(expectedOrigin.hostname)
    && (!origin || origin === expectedOrigin.origin);
}
