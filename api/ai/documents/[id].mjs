import { createHostedRoute, documentDeleteRequest } from "../../../src/hosted/vercel-route.mjs";

export default createHostedRoute({
  hostedPath: "/api/hosted/delete-document",
  methods: ["DELETE"],
  transformRequest: documentDeleteRequest,
});
