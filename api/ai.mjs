import {
  createHostedRoute,
  documentDeleteRequest,
  forwardHostedRequest,
} from "../src/hosted/vercel-route.mjs";

const routes = Object.freeze({
  "/api/ai/health": createHostedRoute({
    hostedPath: "/api/hosted/health",
    methods: ["GET"],
  }),
  "/api/ai/diagnostics": createHostedRoute({
    hostedPath: "/api/hosted/diagnostics",
    methods: ["GET"],
  }),
  "/api/ai/ingest": createHostedRoute({
    hostedPath: "/api/hosted/ingest",
    methods: ["POST"],
  }),
  "/api/ai/answer": createHostedRoute({
    hostedPath: "/api/hosted/answer",
    methods: ["POST"],
  }),
  "/api/ai/documents": createHostedRoute({
    hostedPath: "/api/hosted/documents",
    methods: ["GET"],
  }),
});

const deleteDocumentRoute = createHostedRoute({
  hostedPath: "/api/hosted/delete-document",
  methods: ["DELETE"],
  transformRequest: documentDeleteRequest,
});

export default async function handler(req, res) {
  const pathname = groupedPath(req, "/api/ai");
  const route = routes[pathname];
  if (route) return route(publicRequest(req, pathname), res);
  if (/^\/api\/ai\/documents\/[^/]+$/.test(pathname)) {
    return deleteDocumentRoute(publicRequest(req, pathname), res);
  }
  return sendNotFound(res);
}

function groupedPath(req, prefix) {
  const route = new URL(req?.url || "/", "http://localhost");
  const suffix = pathQuery(req);
  const pathname = suffix ? `${prefix}/${suffix}` : route.pathname;
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

function publicRequest(req, pathname) {
  return forwardHostedRequest(req, { url: publicUrl(req, pathname) });
}

function publicUrl(req, pathname) {
  const route = new URL(req?.url || "/", "http://localhost");
  route.searchParams.delete("path");
  const query = route.searchParams.toString();
  return `${pathname}${query ? `?${query}` : ""}`;
}

function sendNotFound(res) {
  res.setHeader?.("cache-control", "no-store");
  res.setHeader?.("x-content-type-options", "nosniff");
  res.setHeader?.("referrer-policy", "strict-origin-when-cross-origin");
  res.statusCode = 404;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.end?.(JSON.stringify({ error: "API route not found", code: "not_found" }));
}
