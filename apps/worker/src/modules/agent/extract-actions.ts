import type { Env } from "../../platform/config";
import { aiRun } from "./gateway";
import { responseText } from "./summarize";

export interface ActionItem {
  text: string;
  due?: string;
  assignee?: string;
}
export async function extractActionItems(
  env: Env,
  message: string,
): Promise<ActionItem[]> {
  const output = await aiRun<unknown>(env, "@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      {
        role: "system",
        content:
          "Return JSON as an array of action items. Each item has text and optional due and assignee.",
      },
      { role: "user", content: message },
    ],
  });
  const parsed: unknown = JSON.parse(responseText(output));
  if (!Array.isArray(parsed)) throw new Error("Invalid action items");
  return parsed
    .filter(
      (item): item is ActionItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { text?: unknown }).text === "string",
    )
    .map((item) => {
      const value = item as { text: string; due?: unknown; assignee?: unknown };
      return {
        text: value.text,
        ...(typeof value.due === "string" ? { due: value.due } : {}),
        ...(typeof value.assignee === "string"
          ? { assignee: value.assignee }
          : {}),
      };
    });
}
