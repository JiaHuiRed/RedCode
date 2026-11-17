export * as ConfigAttachment from "./attachment"

import { Schema } from "effect"
import { PositiveInt } from "@redcode-ai/core/schema"

export const Image = Schema.Struct({
  auto_resize: Schema.optional(Schema.Boolean).annotate({
    description: "Resize images before sending them to the model when they exceed configured limits (default: true)",
  }),
  max_width: Schema.optional(PositiveInt).annotate({
    description:
      "@deprecated Scaling is driven by max_pixels; this now only contributes to the default pixel budget (max_width * max_height) when max_pixels is unset.",
  }),
  max_height: Schema.optional(PositiveInt).annotate({
    description:
      "@deprecated Scaling is driven by max_pixels; this now only contributes to the default pixel budget (max_width * max_height) when max_pixels is unset.",
  }),
  max_pixels: Schema.optional(PositiveInt).annotate({
    description:
      "Total pixel budget for an attached image (default: 4000000, i.e. 2000x2000). The raster is scaled proportionally to fit this budget, so an extreme aspect ratio such as a tall page screenshot keeps its short-edge resolution instead of being crushed by a per-side box.",
  }),
  max_dimension: Schema.optional(PositiveInt).annotate({
    description:
      "Hard per-side cap applied after the pixel budget (default: 8192). Guards against extreme single-axis sizes that providers reject.",
  }),
  max_base64_bytes: Schema.optional(PositiveInt).annotate({
    description: "Maximum base64 payload bytes for an image attachment (default: 5242880)",
  }),
}).annotate({ identifier: "ImageAttachmentConfig" })
export type Image = Schema.Schema.Type<typeof Image>

export const Info = Schema.Struct({
  image: Schema.optional(Image).annotate({ description: "Image attachment configuration" }),
}).annotate({ identifier: "AttachmentConfig" })
export type Info = Schema.Schema.Type<typeof Info>
