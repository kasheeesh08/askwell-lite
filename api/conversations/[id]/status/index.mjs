import { conversationStatusRequest, createHostedRoute } from "../../../../src/hosted/vercel-route.mjs";

export default createHostedRoute({
  hostedPath: "/api/hosted/conversation-status",
  methods: ["PUT"],
  transformRequest: conversationStatusRequest,
});
