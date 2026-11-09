import {
  conversationDetailRequest,
  conversationMessageRequest,
  conversationStatusRequest,
  createHostedRoute,
  documentDeleteRequest,
  sendPublicConfig,
} from "../src/hosted/vercel-route.mjs";
import {
  sendHostedLogin,
  sendHostedLogout,
  sendHostedSession,
} from "../src/hosted/session-route.mjs";

const routes = Object.freeze({
  "/api/workspace": createHostedRoute({
    hostedPath: "/api/hosted/workspace",
    methods: ["GET", "PUT"],
  }),
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
  "/api/conversations": createHostedRoute({
    hostedPath: "/api/hosted/conversations",
    methods: ["GET", "POST"],
  }),
});

const dynamicRoutes = Object.freeze([
  {
    pattern: /^\/api\/ai\/documents\/[^/]+$/,
    handler: createHostedRoute({
      hostedPath: "/api/hosted/delete-document",
      methods: ["DELETE"],
      transformRequest: documentDeleteRequest,
    }),
  },
  {
    pattern: /^\/api\/conversations\/[^/]+\/messages$/,
    handler: createHostedRoute({
      hostedPath: "/api/hosted/conversation-message",
      methods: ["POST"],
      transformRequest: conversationMessageRequest,
    }),
  },
  {
    pattern: /^\/api\/conversations\/[^/]+\/status$/,
    handler: createHostedRoute({
      hostedPath: "/api/hosted/conversation-status",
      methods: ["PUT"],
      transformRequest: conversationStatusRequest,
    }),
  },
  {
    pattern: /^\/api\/conversations\/[^/]+$/,
    handler: createHostedRoute({
      hostedPath: "/api/hosted/conversation",
      methods: ["GET"],
      transformRequest: conversationDetailRequest,
    }),
  },
]);

export default async function handler(req, res) {
  const pathname = normalizedPath(req?.url);

  if (pathname === "/api/config") return sendPublicConfig(req, res);
  if (pathname === "/api/auth/login") return sendHostedLogin(req, res);
  if (pathname === "/api/auth/logout") return sendHostedLogout(req, res);
  if (pathname === "/api/auth/session") return sendHostedSession(req, res);

  const route = routes[pathname];
  if (route) return route(req, res);

  const dynamic = dynamicRoutes.find(({ pattern }) => pattern.test(pathname));
  if (dynamic) return dynamic.handler(req, res);

  return sendNotFound(res);
}

function normalizedPath(url) {
  const pathname = new URL(url || "/", "http://localhost").pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function sendNotFound(res) {
  res.setHeader?.("cache-control", "no-store");
  res.setHeader?.("x-content-type-options", "nosniff");
  res.setHeader?.("referrer-policy", "strict-origin-when-cross-origin");
  res.statusCode = 404;
  res.setHeader?.("content-type", "application/json; charset=utf-8");
  res.end?.(JSON.stringify({ error: "API route not found", code: "not_found" }));
}
