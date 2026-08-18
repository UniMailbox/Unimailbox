import type { Env } from "../../platform/config";
import { aiRun } from "./gateway";
import { responseText } from "./summarize";

const CANDIDATES = [
  "work",
  "personal",
  "spam",
  "invoice",
  "action_required",
] as const;
export type Classification = { labels: string[]; confidence: number };
export async function classifyMessage(
  env: Env,
  message: string,
): Promise<Classification> {
  const output = await aiRun<unknown>(env, "@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      {
        role: "system",
        content: `Return JSON with labels (from ${CANDIDATES.join(", ")}) and confidence (0 to 1).`,
      },
      { role: "user", content: message },
    ],
  });
  const parsed: unknown = JSON.parse(responseText(output));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("Invalid classification");
  const value = parsed as { labels?: unknown; confidence?: unknown };
  const labels = Array.isArray(value.labels)
    ? value.labels.filter(
        (label): label is string =>
          typeof label === "string" &&
          (CANDIDATES as readonly string[]).includes(label),
      )
    : [];
  const confidence =
    typeof value.confidence === "number"
      ? Math.max(0, Math.min(1, value.confidence))
      : 0;
  return { labels, confidence };
}
export { CANDIDATES as CLASSIFICATION_LABELS };
