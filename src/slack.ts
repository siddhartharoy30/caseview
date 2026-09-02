import { config } from "./config";

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callSlack(method: string, body: Record<string, string>): Promise<SlackApiResponse> {
  const res = await fetch("https://slack.com/api/" + method, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + config.auth.slackBotToken,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });

  const data = (await res.json()) as SlackApiResponse;
  if (!data.ok) {
    throw new Error("Slack API " + method + " failed: " + (data.error || "unknown error"));
  }
  return data;
}

export async function lookupUserIdByEmail(email: string): Promise<string> {
  const data = await callSlack("users.lookupByEmail", { email });
  const user = data.user as { id: string } | undefined;
  if (!user || !user.id) {
    throw new Error("Slack user lookup for " + email + " returned no user id");
  }
  return user.id;
}

export async function sendDirectMessage(userId: string, text: string): Promise<void> {
  await callSlack("chat.postMessage", { channel: userId, text });
}
