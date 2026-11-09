import { sendHostedSession } from "../../src/hosted/session-route.mjs";

export default async function handler(req, res) {
  return sendHostedSession(req, res);
}
