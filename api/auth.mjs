import {
  sendHostedLogin,
  sendHostedLogout,
  sendHostedSession,
} from "../src/hosted/session-route.mjs";

export default async function handler(req, res) {
  const pathname = groupedPath(req, "/api/auth");
  if (pathname === "/api/auth/login") return sendHostedLogin(req, res);
  if (pathname === "/api/auth/logout") return sendHostedLogout(req, res);
  if (pathname === "/api/auth/session") return sendHostedSession(req, res);
  return sendNotFound(res);
}

function groupedPath(req, prefix) {
  const route = new URL(req?.url || "/", "http://localhost");
  const suffix = pathQuery(req);
  if (suffix) return `${prefix}/${suffix}`;
  const pathname = route.pathname;
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function pathQuery(req) {
  const route = new URL(req?.url || "/", "http://localhost");
  const value = req?.query?.path ?? route.searchParams.get("path") ?? "";
  return decodeURIComponent(Array.isArray(value) ? value.join("/") : String(value))
    .split("/")
    .filter(Boolean)
    .join("/");
}

function sendNotFound(res) {
  res.setHeader?.("cache-control", "no-store");
  res.setHeader?.("x-content-type-options", "nosniff");
  res.setHeader?.("referrer-policy", "strict-origin-when-cross-origin");
  res.statusCode = 404;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.end?.(JSON.stringify({ error: "API route not found", code: "not_found" }));
}
