import type { Env } from "../../platform/config";

export async function aiRun<T = unknown>(
  env: Env,
  model: string,
  inputs: unknown,
): Promise<T> {
  if (env.AI_GATEWAY?.run)
    return (await env.AI_GATEWAY.run(
      model,
      inputs as Record<string, unknown>,
    )) as T;
  if (!env.AI) throw new Error("Workers AI binding is unavailable");
  return (await env.AI.run(model, inputs as Record<string, unknown>)) as T;
}
