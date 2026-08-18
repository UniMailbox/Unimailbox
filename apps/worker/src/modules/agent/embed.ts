import type { Env } from "../../platform/config";
import { aiRun } from "./gateway";

const MODEL = "@cf/baai/bge-base-en-v1.5";
export async function embedMessage(env: Env, text: string): Promise<number[]> {
  const output = await aiRun<unknown>(env, MODEL, { text });
  if (
    Array.isArray(output) &&
    output.every((v): v is number => typeof v === "number")
  )
    return output;
  if (typeof output === "object" && output !== null && "data" in output) {
    const data = (output as { data?: unknown }).data;
    if (
      Array.isArray(data) &&
      Array.isArray(data[0]) &&
      data[0].every((v): v is number => typeof v === "number")
    )
      return data[0];
    if (
      Array.isArray(data) &&
      data.every((v): v is number => typeof v === "number")
    )
      return data;
  }
  throw new Error("Workers AI returned an invalid embedding");
}
export { MODEL as EMBEDDING_MODEL };
