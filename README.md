# pi-dynamic-models

Unobtrusive discovery for **local / unnamed OpenAI-compatible providers** under pi.
Point it at any server that speaks the OpenAI API (chat completions **or** responses)
and it self-registers as a provider by fetching `GET {baseUrl}/models` at startup —
no per-model tuning required. Silently no-ops when there's nothing to do.

## Install

```jsonc
// ~/.pi/agent/settings.json → "extensions"
"extensions/pi-dynamic-models"
```

## Config

```jsonc
// ~/.pi/agent/settings/pi-dynamic-models.json  (an array)
[
  {
    "provider": "local-llm",           // required: name shown in the model selector
    "baseUrl":  "http://host:9999/v1", // required: /v1 suffix optional
    "apiKey":   "MY_API_KEY",          // optional: literal, env var name, or !shell-cmd
    "api":      "openai-completions",  // optional: openai-completions (default) | openai-responses
    "compat":   { "supportsUsageInStreaming": true }, // optional compat overrides
    "models": {                        // optional: per-model overrides, all fields optional
      "my-model": { "name": "My Model", "reasoning": true, "contextWindow": 200000,
                    "maxTokens": 32000, "input": ["text", "image"] }
    }
  }
]
```

Minimum viable entry — everything else is discovered or defaulted:

```json
[{ "provider": "local-llm", "baseUrl": "http://host:9999" }]
```

## What's discovered

For each model returned by `/models`, the extension extracts as much as it can and
defaults the rest:

| Setting | Discovery | Fallback |
|---|---|---|
| `contextWindow` | any of ~13 aliases (`max_model_len`, `n_ctx`, …) at top level or under `meta` / `meta.architecture` | `maxTokens` if set, else `128000` |
| `reasoning` | explicit `reasoning` flags or model-id heuristics (`o1/o3`, `r1`, `*-thinking`, `*-reasoning`, …) | `false` |
| `input` | `input_modalities` / `architecture` containing `image` or id heuristics (`vl`, `vision`, `multimodal`, …) | `["text"]` |
| `maxTokens` | — | `16384` (or per-model override) |
| `cost` | — | `0` (unknown for local servers) |

Per-model `models` entries always win over discovery. Server unreachable at startup?
Falls back to configured `models` only (or skips the provider entirely). Never logs
on success; only warns on an unreadable/broken config file.

## Behavior notes

- Registers one provider per config entry; works with any OpenAI-compatible backend
  (llama.cpp, vLLM, Ollama emulation, LM Studio, anonymous gateways, …).
- Defaults to `openai-completions`; set `"api": "openai-responses"` for compatible servers.
- Safe to re-register: a later registration wins for `models` (used when both this and
  a legacy copy are loaded).