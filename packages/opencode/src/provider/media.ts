/**
 * Media generation provider registry.
 *
 * Supports image and video generation APIs with pluggable payload mapping.
 * Built-in adapters for OpenAI DALL-E and Replicate-style APIs are included.
 * Custom providers (e.g. nanobana, seedream) are configured via opencode.json.
 *
 * Example config:
 * ```json
 * {
 *   "media": {
 *     "default_image_provider": "seedream",
 *     "default_video_provider": "nanobana",
 *     "providers": {
 *       "seedream": {
 *         "base_url": "https://api.seedream.com",
 *         "api_key_env": "SEEDREAM_API_KEY",
 *         "capabilities": ["image"],
 *         "image": {
 *           "endpoint": "/v1/generate",
 *           "extra_payload": { "model": "seedream-xl" },
 *           "result_path": "images",
 *           "result_type": "url"
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */

import z from "zod"
import { Log } from "../util/log"
import { Config } from "../config/config"

export namespace MediaProvider {
  const log = Log.create({ service: "media-provider" })

  // ── Schema ────────────────────────────────────────────────────────────────

  export const GenerationEndpoint = z.object({
    /** API path relative to base_url, e.g. "/v1/images/generations" */
    endpoint: z.string(),
    /** Request body fields merged with standard params */
    extra_payload: z.record(z.string(), z.unknown()).optional(),
    /** Field name for the text prompt (default: "prompt") */
    prompt_field: z.string().optional(),
    /** Field name for the count / num_images param (default: "n") */
    count_field: z.string().optional(),
    /** Field name for reference / input images (default: "image") */
    ref_images_field: z.string().optional(),
    /** Field name for the aspect ratio / size param (default: "size") */
    size_field: z.string().optional(),
    /** Field name for input images in video generation (default: "images") */
    input_images_field: z.string().optional(),
    /** Field name for video duration (default: "duration") */
    duration_field: z.string().optional(),
    /**
     * JSONPath-like key to extract result items from the response.
     * Supports simple dot/bracket notation, e.g. "data", "data.images",
     * or omit to use the root array.
     */
    result_path: z.string().optional(),
    /**
     * How results are encoded in the response:
     * - "url"    – each item is a URL string or has a `.url` field
     * - "base64" – each item is a base64 string or has a `.b64_json` field
     */
    result_type: z.enum(["url", "base64"]).default("url"),
    /** MIME type of generated files (default: "image/png" for image, "video/mp4" for video) */
    result_mime: z.string().optional(),
    /**
     * If true the API is asynchronous: the first call returns a job ID and
     * the client must poll a status endpoint until the job is done.
     */
    async_poll: z
      .object({
        /** Path to the job-id field in the initial response, e.g. "id" */
        id_path: z.string(),
        /** Status endpoint template; use "{id}" as placeholder, e.g. "/v1/jobs/{id}" */
        status_endpoint: z.string(),
        /** Field in the status response that holds the current state, e.g. "status" */
        status_field: z.string(),
        /** Value that means the job is done, e.g. "succeeded" */
        done_value: z.string(),
        /** Value that means the job failed, e.g. "failed" */
        failed_value: z.string().optional(),
        /** Path to the output inside the status response, e.g. "output" */
        output_path: z.string(),
        /** Polling interval in milliseconds (default: 2000) */
        interval_ms: z.number().int().positive().optional(),
        /** Maximum polling attempts before giving up (default: 60) */
        max_attempts: z.number().int().positive().optional(),
      })
      .optional(),
  })

  export type GenerationEndpoint = z.infer<typeof GenerationEndpoint>

  export const ProviderConfig = z.object({
    /** Base URL of the API, e.g. "https://api.openai.com" */
    base_url: z.string(),
    /** Name of the env-var that holds the API key */
    api_key_env: z.string().optional(),
    /** Hard-coded API key (prefer api_key_env in production) */
    api_key: z.string().optional(),
    /** What this provider can generate */
    capabilities: z.array(z.enum(["image", "video", "text"])).default(["image"]),
    /** Image generation configuration */
    image: GenerationEndpoint.optional(),
    /** Video generation configuration */
    video: GenerationEndpoint.optional(),
  })

  export type ProviderConfig = z.infer<typeof ProviderConfig>

  // ── Built-in provider definitions ─────────────────────────────────────────

  const BUILTIN: Record<string, ProviderConfig> = {
    "openai-image": {
      base_url: "https://api.openai.com",
      api_key_env: "OPENAI_API_KEY",
      capabilities: ["image"],
      image: {
        endpoint: "/v1/images/generations",
        extra_payload: { model: "dall-e-3", response_format: "b64_json" },
        count_field: "n",
        result_path: "data",
        result_type: "base64",
        result_mime: "image/png",
      },
    },
    "replicate-image": {
      base_url: "https://api.replicate.com",
      api_key_env: "REPLICATE_API_TOKEN",
      capabilities: ["image"],
      image: {
        endpoint: "/v1/models/stability-ai/sdxl/predictions",
        extra_payload: { version: "latest" },
        result_path: "output",
        result_type: "url",
        result_mime: "image/png",
        async_poll: {
          id_path: "id",
          status_endpoint: "/v1/predictions/{id}",
          status_field: "status",
          done_value: "succeeded",
          failed_value: "failed",
          output_path: "output",
          interval_ms: 2000,
          max_attempts: 60,
        },
      },
    },
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Resolve a dotted key path against an object, e.g. "data.images" */
  function dig(obj: unknown, path: string): unknown {
    if (!path) return obj
    return path.split(".").reduce<unknown>((acc, key) => {
      if (acc == null || typeof acc !== "object") return undefined
      return (acc as Record<string, unknown>)[key]
    }, obj)
  }

  /**
   * Normalise a result item to a base64 data-URL.
   * The item may be a URL string (fetched and re-encoded), a plain base64
   * string, or an object with a `.url` / `.b64_json` field.
   */
  async function toDataUrl(item: unknown, cfg: GenerationEndpoint, defaultMime: string): Promise<string> {
    const mime = cfg.result_mime ?? defaultMime
    if (cfg.result_type === "base64") {
      const b64 = typeof item === "string" ? item : (item as Record<string, string>).b64_json ?? ""
      return `data:${mime};base64,${b64}`
    }
    // result_type === "url"
    const url = typeof item === "string" ? item : (item as Record<string, string>).url ?? ""
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Failed to fetch generated media from ${url}: ${res.status}`)
    const buf = await res.arrayBuffer()
    const actualMime = res.headers.get("content-type")?.split(";")[0] ?? mime
    return `data:${actualMime};base64,${Buffer.from(buf).toString("base64")}`
  }

  /** Poll an async generation API until the job finishes or we time out. */
  async function poll(baseUrl: string, headers: Record<string, string>, jobId: string, cfg: GenerationEndpoint) {
    const pc = cfg.async_poll!
    const interval = pc.interval_ms ?? 2000
    const max = pc.max_attempts ?? 60

    for (let attempt = 0; attempt < max; attempt++) {
      await new Promise((r) => setTimeout(r, interval))
      const url = baseUrl + pc.status_endpoint.replace("{id}", jobId)
      const res = await fetch(url, { headers })
      if (!res.ok) throw new Error(`Polling status failed: ${res.status}`)
      const body = (await res.json()) as Record<string, unknown>
      const status = dig(body, pc.status_field) as string
      if (pc.failed_value && status === pc.failed_value)
        throw new Error(`Generation job ${jobId} failed: ${JSON.stringify(body)}`)
      if (status === pc.done_value) return dig(body, pc.output_path)
    }
    throw new Error(`Generation job ${jobId} timed out after ${max} attempts`)
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Look up a provider by id from config + built-ins */
  export async function get(id: string): Promise<ProviderConfig> {
    const cfg = await Config.get()
    const custom = cfg.media?.providers?.[id]
    if (custom) return custom as ProviderConfig
    const builtin = BUILTIN[id]
    if (builtin) return builtin
    throw new Error(`Media provider "${id}" not found. Add it to the 'media.providers' section of your config.`)
  }

  /** Return the default provider id for image or video generation */
  export async function defaultProvider(capability: "image" | "video"): Promise<string> {
    const cfg = await Config.get()
    if (capability === "image") {
      return cfg.media?.default_image_provider ?? "openai-image"
    }
    return cfg.media?.default_video_provider ?? ""
  }

  export interface GenerateImageParams {
    prompt: string
    count?: number
    refImages?: string[] // base64 data-URLs or HTTP URLs
    aspectRatio?: "square" | "landscape" | "portrait"
    provider?: string
  }

  export interface GenerateVideoParams {
    prompt: string
    inputImages?: string[] // base64 data-URLs or HTTP URLs from prior imagegen
    duration?: number // seconds
    provider?: string
  }

  /** Generate images using the configured provider */
  export async function generateImages(params: GenerateImageParams): Promise<string[]> {
    const id = params.provider ?? (await defaultProvider("image"))
    if (!id) throw new Error("No image provider configured. Set 'media.default_image_provider' in your config.")
    const cfg = await get(id)
    if (!cfg.image) throw new Error(`Provider "${id}" has no image generation endpoint configured.`)

    const key = cfg.api_key ?? (cfg.api_key_env ? process.env[cfg.api_key_env] : undefined)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (key) headers["Authorization"] = `Bearer ${key}`

    const ep = cfg.image
    const promptField = ep.prompt_field ?? "prompt"
    const countField = ep.count_field ?? "n"

    const body: Record<string, unknown> = {
      ...(ep.extra_payload ?? {}),
      [promptField]: params.prompt,
      [countField]: params.count ?? 1,
    }

    // Include ref images if provided; field name is configurable per provider
    if (params.refImages?.length) {
      const field = ep.ref_images_field ?? "image"
      body[field] = params.refImages.length === 1 ? params.refImages[0] : params.refImages
    }

    // Aspect ratio hint; field name is configurable per provider
    if (params.aspectRatio) {
      const sizes: Record<string, string> = { square: "1024x1024", landscape: "1792x1024", portrait: "1024x1792" }
      const field = ep.size_field ?? "size"
      body[field] = sizes[params.aspectRatio]
    }

    log.info("generating images", { provider: id, prompt: params.prompt, count: params.count ?? 1 })

    const res = await fetch(cfg.base_url + ep.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => res.status.toString())
      throw new Error(`Image generation failed (${res.status}): ${txt}`)
    }

    let raw: unknown = await res.json()

    // Handle async polling APIs
    if (ep.async_poll) {
      const jobId = dig(raw as Record<string, unknown>, ep.async_poll.id_path) as string
      if (!jobId) throw new Error("Async generation API did not return a job id")
      raw = await poll(cfg.base_url, headers, jobId, ep)
    }

    // Extract result items
    const items = ep.result_path ? (dig(raw as Record<string, unknown>, ep.result_path) as unknown[]) : (raw as unknown[])
    if (!Array.isArray(items)) throw new Error(`Unexpected response shape from provider "${id}": ${JSON.stringify(raw)}`)

    return Promise.all(items.map((item) => toDataUrl(item, ep, "image/png")))
  }

  /** Generate a video using the configured provider */
  export async function generateVideo(params: GenerateVideoParams): Promise<string[]> {
    const id = params.provider ?? (await defaultProvider("video"))
    if (!id) throw new Error("No video provider configured. Set 'media.default_video_provider' in your config.")
    const cfg = await get(id)
    if (!cfg.video) throw new Error(`Provider "${id}" has no video generation endpoint configured.`)

    const key = cfg.api_key ?? (cfg.api_key_env ? process.env[cfg.api_key_env] : undefined)
    const headers: Record<string, string> = { "Content-Type": "application/json" }
    if (key) headers["Authorization"] = `Bearer ${key}`

    const ep = cfg.video
    const promptField = ep.prompt_field ?? "prompt"

    const body: Record<string, unknown> = {
      ...(ep.extra_payload ?? {}),
      [promptField]: params.prompt,
    }

    if (params.inputImages?.length) {
      const field = ep.input_images_field ?? "images"
      body[field] = params.inputImages
    }
    if (params.duration != null) {
      const field = ep.duration_field ?? "duration"
      body[field] = params.duration
    }

    log.info("generating video", { provider: id, prompt: params.prompt })

    const res = await fetch(cfg.base_url + ep.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => res.status.toString())
      throw new Error(`Video generation failed (${res.status}): ${txt}`)
    }

    let raw: unknown = await res.json()

    if (ep.async_poll) {
      const jobId = dig(raw as Record<string, unknown>, ep.async_poll.id_path) as string
      if (!jobId) throw new Error("Async generation API did not return a job id")
      raw = await poll(cfg.base_url, headers, jobId, ep)
    }

    const items = ep.result_path ? (dig(raw as Record<string, unknown>, ep.result_path) as unknown[]) : (raw as unknown[])
    if (!Array.isArray(items)) throw new Error(`Unexpected response shape from provider "${id}": ${JSON.stringify(raw)}`)

    return Promise.all(items.map((item) => toDataUrl(item, ep, "video/mp4")))
  }
}
