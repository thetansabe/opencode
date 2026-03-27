import z from "zod"
import { Tool } from "./tool"
import { MediaProvider } from "../provider/media"

export const VideoGenTool = Tool.define("videogen", {
  description: `Generate a video from a text prompt and/or a set of input images using a configured video generation API (e.g. Nanobana, Seedream, Replicate).

Use this tool when the user asks to:
- Create, produce or render a video / animation / clip
- Turn a set of images into a video sequence
- Generate video content based on a description

Typical multi-step workflow:
1. User says "Generate 4 images of a walking girl" → call imagegen
2. User says "Now make a video from those images" → call videogen with the image URLs returned by imagegen

The tool returns the generated video as a file attachment.`,

  parameters: z.object({
    prompt: z.string().describe("Text prompt describing the video content, motion and style"),
    input_images: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of image data-URLs or paths to use as the visual basis for the video (from a prior imagegen call or user-provided files)",
      ),
    duration: z
      .number()
      .positive()
      .optional()
      .describe("Desired video duration in seconds (provider-dependent, may be ignored)"),
    provider: z.string().optional().describe("Override the default video provider configured in 'media.default_video_provider'"),
  }),

  async execute(params, ctx) {
    const urls = await MediaProvider.generateVideo({
      prompt: params.prompt,
      inputImages: params.input_images,
      duration: params.duration,
      provider: params.provider,
    })

    const attachments = urls.map((url) => {
      const mime = url.startsWith("data:") ? url.slice(5, url.indexOf(";")) : "video/mp4"
      return {
        type: "file" as const,
        mime,
        url,
      }
    })

    return {
      title: `Generated ${urls.length} video${urls.length !== 1 ? "s" : ""}`,
      output: `Successfully generated ${urls.length} video${urls.length !== 1 ? "s" : ""}. The video is attached to this message.`,
      metadata: { truncated: false, count: urls.length },
      attachments,
    }
  },
})
