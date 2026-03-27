import z from "zod"
import { Tool } from "./tool"
import { MediaProvider } from "../provider/media"

export const ImageGenTool = Tool.define("imagegen", {
  description: `Generate images from a text prompt using a configured image generation API (e.g. DALL-E, Seedream, Nanobana, Replicate).

Use this tool when the user asks to:
- Create, draw, paint or generate images/pictures/photos/illustrations
- Produce visual content based on a description
- Generate variations or stylised versions of existing images

The tool returns the generated images as file attachments so you can reference them in subsequent turns (e.g. to generate a video from them).

Tips:
- For multi-step workflows (image → video) pass the urls from this tool's attachments to the videogen tool.
- If the user provides a reference image file, include its path in ref_images.
- aspect_ratio defaults to "square".`,

  parameters: z.object({
    prompt: z.string().describe("Detailed text prompt describing the image(s) to generate"),
    count: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .default(1)
      .describe("Number of images to generate (default: 1)"),
    ref_images: z
      .array(z.string())
      .optional()
      .describe(
        "Optional list of reference image paths or data-URLs to guide generation (e.g. style transfer or img2img)",
      ),
    aspect_ratio: z
      .enum(["square", "landscape", "portrait"])
      .optional()
      .default("square")
      .describe("Aspect ratio of the generated images"),
    provider: z.string().optional().describe("Override the default image provider configured in 'media.default_image_provider'"),
  }),

  async execute(params, ctx) {
    const urls = await MediaProvider.generateImages({
      prompt: params.prompt,
      count: params.count,
      refImages: params.ref_images,
      aspectRatio: params.aspect_ratio,
      provider: params.provider,
    })

    const attachments = urls.map((url) => {
      const mime = url.startsWith("data:") ? url.slice(5, url.indexOf(";")) : "image/png"
      return {
        type: "file" as const,
        mime,
        url,
      }
    })

    return {
      title: `Generated ${urls.length} image${urls.length !== 1 ? "s" : ""}`,
      output: `Successfully generated ${urls.length} image${urls.length !== 1 ? "s" : ""}. The images are attached to this message. You can reference them in follow-up requests (e.g. to generate a video).`,
      metadata: { truncated: false, count: urls.length },
      attachments,
    }
  },
})
