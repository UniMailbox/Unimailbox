import type { Env } from "../../platform/config";
import { aiRun } from "./gateway";

const MODEL = "@cf/meta/llama-3.1-8b-instruct";
function responseText(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "response" in value &&
    typeof (value as { response: unknown }).response === "string"
  )
    return (value as { response: string }).response;
  throw new Error("Workers AI returned an invalid summary");
}
export async function summarizeThread(
  env: Env,
  messages: readonly string[],
): Promise<string> {
  const context = messages.join("\n\n").slice(0, 8000);
  const output = await aiRun<unknown>(env, MODEL, {
    messages: [
      {
        role: "system",
        content: "Summarize the email thread in 300 characters or fewer.",
      },
      { role: "user", content: context },
    ],
  });
  return responseText(output).slice(0, 300);
}
export { MODEL as SUMMARY_MODEL };
export { responseText };
