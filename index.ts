/**
 * pi-dynamic-models — unobtrusive OpenAI-compatible provider discovery.
 *
 * Reads ~/.pi/agent/settings/pi-dynamic-models.json, fetches GET {baseUrl}/models
 * at startup, and registers each server as a named Pi provider. Silently no-ops
 * when there is nothing to do; the only console output is a warning when the
 * config file itself is unreadable.
 *
 * Config (~/.pi/agent/settings/pi-dynamic-models.json):
 *
 *   [
 *     {
 *       "provider": "local-llm",              // name shown in the model selector
 *       "baseUrl":  "http://host:9999/v1",    // server URL, /v1 suffix optional
 *       "apiKey":   "MY_API_KEY",             // literal, env var name, or !shell-cmd
 *       "api":      "openai-completions",     // optional, default openai-completions
 *       "compat":   { ... },                  // optional OpenAICompletionsCompat overrides
 *       "models": {                           // optional per-model overrides (all optional)
 *         "my-model": { "name":"My Model", "reasoning":true,
 *                       "contextWindow":200000, "maxTokens":32000,
 *                       "input":["text","image"] }
 *       }
 *     }
 *   ]
 *
 * Model settings are discovered from the /models response wherever the server
 * exposes them (surface is inconsistent across servers), falling back to
 * sensible defaults. Per-model "models" entries always win over discovery.
 */

import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// Loosely typed: servers return wildly different shapes. We probe defensively.
interface RemoteModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  vision?: boolean;
  input_modalities?: unknown;
  architecture?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

interface ModelOverride {
  name?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
}

interface ServerConfig {
  provider: string;
  baseUrl: string;
  apiKey?: string;
  api?: string;
  compat?: Record<string, unknown>;
  models?: Record<string, ModelOverride>;
}

const CONFIG_FILE = join(getAgentDir(), "settings", "pi-dynamic-models.json");

// Candidate keys, in priority order, for a remote model's context window.
// Probed at the top level and inside `meta` (and `meta.architecture`) since
// llama.cpp, vLLM, Ollama emulation, and friends each use different names.
const CTX_KEYS = [
  "max_model_len", "max_context_length", "context_length", "context_window",
  "contextWindow", "nctx", "n_ctx", "n_ctx_train", "n_positions", "nmax_positions",
  "total_tokens", "seqlen", "max_position_embeddings",
] as const;

function loadConfig(): ServerConfig[] {
  if (!existsSync(CONFIG_FILE)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch (err) {
    console.warn(`[pi-dynamic-models] Failed to parse ${CONFIG_FILE}: ${err}`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(`[pi-dynamic-models] ${CONFIG_FILE} must be a JSON array`);
    return [];
  }
  const valid: ServerConfig[] = [];
  for (const entry of parsed) {
    if (!entry?.provider || !entry?.baseUrl) {
      console.warn(`[pi-dynamic-models] Skipping entry missing "provider" or "baseUrl": ${JSON.stringify(entry)}`);
      continue;
    }
    valid.push(entry);
  }
  return valid;
}

async function fetchRemoteModels(baseUrl: string, apiKey?: string): Promise<RemoteModel[]> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { data?: RemoteModel[] } | RemoteModel[];
  return Array.isArray(body) ? body : (body.data ?? []);
}

/** First positive integer found for any key across a model's probe surfaces. */
function pickInt(model: RemoteModel, keys: readonly string[]): number | undefined {
  const surfaces: unknown[] = [model, model.meta, model.meta?.architecture];
  for (const key of keys) {
    for (const surface of surfaces) {
      const value = surface?.[key as string];
      if (typeof value === "number" && Number.isInteger(value) && value > 0) return value;
    }
  }
  return undefined;
}

const asBool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

function setIncludesImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.includes("image");
  if (value && typeof value === "object") {
    const any = value as Record<string, unknown>;
    if (any.image === true) return true;
    if (["image", "vision", "multimodal"].some((k) => any[k] === true)) return true;
  }
  return false;
}

// Heuristics for fields /models almost never reports explicitly.
const REASONING_ID = /\b(o[134]|o[134]-mini|r1|r1-|r2|deepseek-reasoner|grok-.*-reasoning|.*-thinking|.*-think|.*-reasoning)\b/i;
const VISION_ID = /\b(vl|vision|vlm|multimodal|omni|image)\b/i;

function discoverModel(remote: RemoteModel, override?: ModelOverride) {
  const id = remote.id;
  const contextWindow = override?.contextWindow
    ?? pickInt(remote, CTX_KEYS)
    ?? (override?.maxTokens ? override.maxTokens : 128_000);
  const reasoning = override?.reasoning
    ?? asBool(remote.reasoning)
    ?? asBool(remote.meta?.reasoning)
    ?? REASONING_ID.test(id);
  const vision = setIncludesImage(remote.input_modalities)
    ?? setIncludesImage(remote.meta?.input_modalities)
    ?? setIncludesImage(remote.architecture?.input_modalities)
    ?? VISION_ID.test(id);
  return {
    id,
    name: override?.name ?? remote.name ?? id,
    reasoning,
    input: override?.input ?? (vision ? ["text", "image"] : ["text"]),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: override?.maxTokens ?? 16_384,
  };
}

export default async function (pi: ExtensionAPI): Promise<void> {
  const servers = loadConfig();
  if (servers.length === 0) return;

  await Promise.all(
    servers.map(async ({ provider, baseUrl, apiKey, api, compat, models: overrides }) => {
      let remoteModels: RemoteModel[] = [];
      try {
        remoteModels = await fetchRemoteModels(baseUrl, apiKey);
      } catch {
        // Unreachable/server error: keep going with configured models only, or skip.
        if (!overrides || Object.keys(overrides).length === 0) return;
      }

      const remoteById = new Map(remoteModels.map((m) => [m.id, m]));
      const ids = new Set([...remoteById.keys(), ...Object.keys(overrides ?? {})]);
      if (ids.size === 0) return;

      pi.registerProvider(provider, {
        baseUrl: baseUrl.replace(/\/+$/, ""),
        apiKey: apiKey ?? "none",
        authHeader: !!apiKey,
        api: (api ?? "openai-completions") as "openai-completions" | "openai-responses",
        models: [...ids]
          .sort((a, b) => a.localeCompare(b))
          .map((id) => discoverModel(remoteById.get(id) ?? { id }, overrides?.[id])),
        ...(compat ? { compat } : {}),
      });
    })
  );
}