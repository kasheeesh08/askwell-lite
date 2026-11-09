import { sendHostedLogout } from "../../src/hosted/session-route.mjs";

export default async function handler(req, res) {
  return sendHostedLogout(req, res);
}
