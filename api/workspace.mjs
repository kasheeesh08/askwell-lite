import { createHostedRoute } from "../src/hosted/vercel-route.mjs";

export default createHostedRoute({
  hostedPath: "/api/hosted/workspace",
  methods: ["GET", "PUT"],
});
