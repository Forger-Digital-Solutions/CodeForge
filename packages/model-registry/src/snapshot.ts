import type { ModelsDevDoc } from "./models-dev.js";

/**
 * Bundled offline snapshot of the Models.dev catalog, trimmed to CodeForge-supported providers.
 * Captured from https://models.dev/api.json on 2026-08-29. Ensures CodeForge launches and can
 * classify models WITHOUT internet access; the live fetch refreshes this at runtime when reachable.
 * Regenerate by re-pulling api.json and re-trimming (see docs/research/provider-model-access-2026.md).
 */
export const MODELS_DEV_SNAPSHOT_CAPTURED_AT = "2026-08-29T00:00:00.000Z";

export const MODELS_DEV_SNAPSHOT: ModelsDevDoc = {
  "openrouter": {
    "id": "openrouter",
    "name": "OpenRouter",
    "env": [
      "OPENROUTER_API_KEY"
    ],
    "npm": "@openrouter/ai-sdk-provider",
    "api": "https://openrouter.ai/api/v1",
    "doc": "https://openrouter.ai/models",
    "models": {
      "nvidia/nemotron-3-super-120b-a12b:free": {
        "id": "nvidia/nemotron-3-super-120b-a12b:free",
        "name": "Nemotron 3 Super (free)",
        "family": "nemotron",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": true,
        "last_updated": "2026-03-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 235929
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3.5-lightning:free": {
        "id": "nvidia/nemotron-3.5-lightning:free",
        "name": "Nemotron 3.5 Lightning (free)",
        "family": "nemotron",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2026-08-11",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
        "id": "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        "name": "Nemotron 3 Nano Omni (free)",
        "family": "nemotron",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2026-04-28",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3.5-content-safety:free": {
        "id": "nvidia/nemotron-3.5-content-safety:free",
        "name": "Nemotron 3.5 Content Safety (free)",
        "family": "nemotron",
        "attachment": true,
        "reasoning": true,
        "tool_call": false,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2026-06-04",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 8192
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "nvidia/nemotron-3-ultra-550b-a55b:free": {
        "id": "nvidia/nemotron-3-ultra-550b-a55b:free",
        "name": "Nemotron 3 Ultra (free)",
        "family": "nemotron",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2026-06-04",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "z-ai/glm-5.2:free": {
        "id": "z-ai/glm-5.2:free",
        "name": "GLM 5.2 (free)",
        "family": "glm",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": true,
        "last_updated": "2026-06-13",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 256000,
          "output": 230400
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "inclusionai/ling-3.0-flash": {
        "id": "inclusionai/ling-3.0-flash",
        "name": "Ling-3.0-flash",
        "family": "ling",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2026-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 262144,
          "output": 32768
        },
        "cost": {
          "input": 0.021,
          "output": 0.063,
          "cache_read": 0.0042
        }
      },
      "~deepseek/deepseek-v4-flash-latest": {
        "id": "~deepseek/deepseek-v4-flash-latest",
        "name": "DeepSeek V4 Flash Latest",
        "family": "deepseek",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2026-08-01",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 131072
        },
        "cost": {
          "input": 0.03,
          "output": 0.1,
          "cache_read": 0.007
        }
      },
      "meta-llama/llama-3.1-8b-instruct": {
        "id": "meta-llama/llama-3.1-8b-instruct",
        "name": "Llama-3.1-8B-Instruct",
        "family": "llama",
        "attachment": false,
        "reasoning": false,
        "tool_call": true,
        "structured_output": true,
        "open_weights": true,
        "last_updated": "2024-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 117964
        },
        "cost": {
          "input": 0.05,
          "output": 0.08,
          "cache_read": 0.025
        }
      },
      "deepseek/deepseek-v4-flash-0731": {
        "id": "deepseek/deepseek-v4-flash-0731",
        "name": "DeepSeek V4 Flash 0731",
        "family": "deepseek-flash",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": true,
        "last_updated": "2026-07-31",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1310720,
          "output": 943718
        },
        "cost": {
          "input": 0.045,
          "output": 0.09,
          "cache_read": 0.009
        }
      }
    }
  },
  "zai": {
    "id": "zai",
    "name": "Z.AI",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.z.ai/api/paas/v4",
    "doc": "https://docs.z.ai/guides/overview/pricing",
    "models": {
      "glm-4.5-flash": {
        "id": "glm-4.5-flash",
        "name": "GLM-4.5-Flash",
        "family": "glm-flash",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-4.7-flash": {
        "id": "glm-4.7-flash",
        "name": "GLM-4.7-Flash",
        "family": "glm-flash",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0,
          "output": 0,
          "cache_read": 0,
          "cache_write": 0
        }
      },
      "glm-5.3-flash": {
        "id": "glm-5.3-flash",
        "name": "GLM-5.3-Flash",
        "family": "glm",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2026-08-26",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 131072
        },
        "cost": {
          "input": 0.075,
          "output": 0.25,
          "cache_read": 0.015,
          "cache_write": 0
        }
      },
      "glm-4.7-flashx": {
        "id": "glm-4.7-flashx",
        "name": "GLM-4.7-FlashX",
        "family": "glm-flash",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2026-01-19",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 131072
        },
        "cost": {
          "input": 0.07,
          "output": 0.4,
          "cache_read": 0.01,
          "cache_write": 0
        }
      },
      "glm-4.6v": {
        "id": "glm-4.6v",
        "name": "GLM-4.6V",
        "family": "glm",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2025-12-08",
        "modalities": {
          "input": [
            "text",
            "image",
            "video"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 32768
        },
        "cost": {
          "input": 0.3,
          "output": 0.9
        }
      },
      "glm-4.5-air": {
        "id": "glm-4.5-air",
        "name": "GLM-4.5-Air",
        "family": "glm-air",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2025-07-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 98304
        },
        "cost": {
          "input": 0.2,
          "output": 1.1,
          "cache_read": 0.03,
          "cache_write": 0
        }
      }
    }
  },
  "google": {
    "id": "google",
    "name": "Google",
    "env": [
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "GEMINI_API_KEY"
    ],
    "npm": "@ai-sdk/google",
    "doc": "https://ai.google.dev/gemini-api/docs/models",
    "models": {
      "lyria-3-clip-preview": {
        "id": "lyria-3-clip-preview",
        "name": "Lyria 3 Clip Preview",
        "family": "lyria",
        "attachment": true,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": false,
        "last_updated": "2026-03-25",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "lyria-3-pro-preview": {
        "id": "lyria-3-pro-preview",
        "name": "Lyria 3 Pro Preview",
        "family": "lyria",
        "attachment": true,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": false,
        "last_updated": "2026-03-25",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text",
            "audio"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "gemini-embedding-001": {
        "id": "gemini-embedding-001",
        "name": "Gemini Embedding 001",
        "family": "gemini",
        "attachment": false,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": false,
        "last_updated": "2025-05-20",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 2048,
          "output": 1
        },
        "cost": {
          "input": 0.15,
          "output": 0
        }
      },
      "gemini-embedding-2": {
        "id": "gemini-embedding-2",
        "name": "Gemini Embedding 2",
        "family": "gemini",
        "attachment": true,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": false,
        "last_updated": "2026-04-22",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 8192,
          "output": 1
        },
        "cost": {
          "input": 0.2,
          "output": 0,
          "input_audio": 6.5
        }
      },
      "gemini-2.5-flash-lite": {
        "id": "gemini-2.5-flash-lite",
        "name": "Gemini 2.5 Flash-Lite",
        "family": "gemini-flash-lite",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2025-06-17",
        "modalities": {
          "input": [
            "text",
            "image",
            "audio",
            "video",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.1,
          "output": 0.4,
          "cache_read": 0.01,
          "input_audio": 0.3
        }
      },
      "gemini-3.1-flash-lite": {
        "id": "gemini-3.1-flash-lite",
        "name": "Gemini 3.1 Flash Lite",
        "family": "gemini-flash-lite",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2026-05-07",
        "modalities": {
          "input": [
            "text",
            "image",
            "video",
            "audio",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1048576,
          "output": 65536
        },
        "cost": {
          "input": 0.25,
          "output": 1.5,
          "cache_read": 0.025,
          "input_audio": 0.5
        }
      }
    }
  },
  "groq": {
    "id": "groq",
    "name": "Groq",
    "env": [
      "GROQ_API_KEY"
    ],
    "npm": "@ai-sdk/groq",
    "doc": "https://console.groq.com/docs/models",
    "models": {
      "allam-2-7b": {
        "id": "allam-2-7b",
        "name": "ALLaM-2-7b",
        "attachment": false,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2025-01-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 4096,
          "output": 4096
        },
        "cost": {
          "input": 0,
          "output": 0
        }
      },
      "meta-llama/llama-prompt-guard-2-22m": {
        "id": "meta-llama/llama-prompt-guard-2-22m",
        "name": "Llama Prompt Guard 2 22M",
        "family": "llama",
        "attachment": false,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2025-05-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 512,
          "output": 512
        },
        "cost": {
          "input": 0.03,
          "output": 0.03
        }
      },
      "meta-llama/llama-prompt-guard-2-86m": {
        "id": "meta-llama/llama-prompt-guard-2-86m",
        "name": "Prompt Guard 2 86M",
        "family": "llama",
        "attachment": false,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2025-05-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 512,
          "output": 512
        },
        "cost": {
          "input": 0.04,
          "output": 0.04
        }
      },
      "llama-3.1-8b-instant": {
        "id": "llama-3.1-8b-instant",
        "name": "Llama 3.1 8B",
        "family": "llama",
        "attachment": false,
        "reasoning": false,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2024-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 131072
        },
        "cost": {
          "input": 0.05,
          "output": 0.08
        }
      },
      "openai/gpt-oss-safeguard-20b": {
        "id": "openai/gpt-oss-safeguard-20b",
        "name": "Safety GPT OSS 20B",
        "family": "gpt-oss",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": true,
        "last_updated": "2026-06-29",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 131072,
          "output": 65536
        },
        "cost": {
          "input": 0.075,
          "output": 0.3
        }
      }
    }
  },
  "cloudflare-workers-ai": {
    "id": "cloudflare-workers-ai",
    "name": "Cloudflare Workers AI",
    "env": [
      "CLOUDFLARE_ACCOUNT_ID",
      "CLOUDFLARE_API_KEY"
    ],
    "npm": "@ai-sdk/openai-compatible",
    "api": "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "doc": "https://developers.cloudflare.com/workers-ai/models/",
    "models": {
      "@cf/meta/llama-3.2-1b-instruct": {
        "id": "@cf/meta/llama-3.2-1b-instruct",
        "name": "Llama 3.2 1B Instruct",
        "family": "llama",
        "attachment": false,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2024-09-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 60000,
          "output": 60000
        },
        "cost": {
          "input": 0.027,
          "output": 0.201
        }
      },
      "@cf/meta/llama-3.2-3b-instruct": {
        "id": "@cf/meta/llama-3.2-3b-instruct",
        "name": "Llama 3.2 3B Instruct",
        "family": "llama",
        "attachment": false,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2024-09-25",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 80000,
          "output": 80000
        },
        "cost": {
          "input": 0.0509,
          "output": 0.335
        }
      },
      "@cf/qwen/qwen3-30b-a3b-fp8": {
        "id": "@cf/qwen/qwen3-30b-a3b-fp8",
        "name": "Qwen3 30B A3b fp8",
        "family": "qwen",
        "attachment": false,
        "reasoning": true,
        "tool_call": true,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2025-04-28",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32768,
          "output": 32768
        },
        "cost": {
          "input": 0.0509,
          "output": 0.335
        }
      },
      "@cf/meta/llama-3.1-8b-instruct-fp8": {
        "id": "@cf/meta/llama-3.1-8b-instruct-fp8",
        "name": "Llama 3.1 8B Instruct fp8",
        "family": "llama",
        "attachment": false,
        "reasoning": false,
        "tool_call": false,
        "structured_output": false,
        "open_weights": true,
        "last_updated": "2024-07-23",
        "modalities": {
          "input": [
            "text"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 32000,
          "output": 32000
        },
        "cost": {
          "input": 0.152,
          "output": 0.287
        }
      }
    }
  },
  "openai": {
    "id": "openai",
    "name": "OpenAI",
    "env": [
      "OPENAI_API_KEY"
    ],
    "npm": "@ai-sdk/openai",
    "doc": "https://platform.openai.com/docs/models",
    "models": {
      "gpt-5-nano": {
        "id": "gpt-5-nano",
        "name": "GPT-5 Nano",
        "family": "gpt-nano",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2025-08-07",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 400000,
          "input": 272000,
          "output": 128000
        },
        "cost": {
          "input": 0.05,
          "output": 0.4,
          "cache_read": 0.005
        }
      },
      "gpt-4.1-nano": {
        "id": "gpt-4.1-nano",
        "name": "GPT-4.1 nano",
        "family": "gpt-nano",
        "attachment": true,
        "reasoning": false,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2025-04-14",
        "modalities": {
          "input": [
            "text",
            "image"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1047576,
          "output": 32768
        },
        "cost": {
          "input": 0.1,
          "output": 0.4,
          "cache_read": 0.025
        }
      },
      "gpt-4o-mini": {
        "id": "gpt-4o-mini",
        "name": "GPT-4o mini",
        "family": "gpt-mini",
        "attachment": true,
        "reasoning": false,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2024-07-18",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 128000,
          "output": 16384
        },
        "cost": {
          "input": 0.15,
          "output": 0.6,
          "cache_read": 0.075
        }
      },
      "gpt-5.6-luna": {
        "id": "gpt-5.6-luna",
        "name": "GPT-5.6 Luna",
        "family": "gpt-luna",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2026-07-09",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1050000,
          "input": 922000,
          "output": 128000
        },
        "cost": {
          "input": 0.2,
          "output": 1.2,
          "cache_read": 0.02,
          "cache_write": 0.25,
          "tiers": [
            {
              "input": 0.4,
              "output": 1.8,
              "cache_read": 0.04,
              "cache_write": 0.5,
              "tier": {
                "type": "context",
                "size": 272000
              }
            }
          ],
          "context_over_200k": {
            "input": 0.4,
            "output": 1.8,
            "cache_read": 0.04,
            "cache_write": 0.5
          }
        }
      }
    }
  },
  "anthropic": {
    "id": "anthropic",
    "name": "Anthropic",
    "env": [
      "ANTHROPIC_API_KEY"
    ],
    "npm": "@ai-sdk/anthropic",
    "doc": "https://docs.anthropic.com/en/docs/about-claude/models",
    "models": {
      "claude-haiku-4-5-20251001": {
        "id": "claude-haiku-4-5-20251001",
        "name": "Claude Haiku 4.5",
        "family": "claude-haiku",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 1,
          "output": 5,
          "cache_read": 0.1,
          "cache_write": 1.25
        }
      },
      "claude-haiku-4-5": {
        "id": "claude-haiku-4-5",
        "name": "Claude Haiku 4.5 (latest)",
        "family": "claude-haiku",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2025-10-15",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 200000,
          "output": 64000
        },
        "cost": {
          "input": 1,
          "output": 5,
          "cache_read": 0.1,
          "cache_write": 1.25
        }
      },
      "claude-sonnet-5": {
        "id": "claude-sonnet-5",
        "name": "Claude Sonnet 5",
        "family": "claude-sonnet",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2026-06-30",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 128000
        },
        "cost": {
          "input": 2,
          "output": 10,
          "cache_read": 0.2,
          "cache_write": 2.5
        }
      },
      "claude-sonnet-4-5-20250929": {
        "id": "claude-sonnet-4-5-20250929",
        "name": "Claude Sonnet 4.5",
        "family": "claude-sonnet",
        "attachment": true,
        "reasoning": true,
        "tool_call": true,
        "structured_output": true,
        "open_weights": false,
        "last_updated": "2025-09-29",
        "modalities": {
          "input": [
            "text",
            "image",
            "pdf"
          ],
          "output": [
            "text"
          ]
        },
        "limit": {
          "context": 1000000,
          "output": 64000
        },
        "cost": {
          "input": 3,
          "output": 15,
          "cache_read": 0.3,
          "cache_write": 3.75
        }
      }
    }
  }
} as unknown as ModelsDevDoc;
