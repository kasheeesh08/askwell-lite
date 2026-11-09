import { conversationMessageRequest, createHostedRoute } from "../../../src/hosted/vercel-route.mjs";

export default createHostedRoute({
  hostedPath: "/api/hosted/conversation-message",
  methods: ["POST"],
  transformRequest: conversationMessageRequest,
});
