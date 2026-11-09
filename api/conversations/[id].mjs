import { conversationDetailRequest, createHostedRoute } from "../../src/hosted/vercel-route.mjs";

export default createHostedRoute({
  hostedPath: "/api/hosted/conversation",
  methods: ["GET"],
  transformRequest: conversationDetailRequest,
});
