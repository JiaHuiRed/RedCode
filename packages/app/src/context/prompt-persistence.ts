import type { ContentPart, ImageAttachmentPart, Prompt } from "./prompt"

export function splitPromptImages(prompt: Prompt) {
  const text: Prompt = []
  const images: ImageAttachmentPart[] = []
  for (const part of prompt) {
    if (part.type === "image") images.push(part)
    else text.push(part)
  }
  return { text, images }
}

export function mergePromptImages(prompt: Prompt, images: ImageAttachmentPart[]): Prompt {
  return [...prompt, ...images]
}

export function samePromptImages(left: ImageAttachmentPart[], right: ImageAttachmentPart[]) {
  return left.length === right.length && left.every((part, index) => part.id === right[index]?.id)
}

export function migratePromptImages(prompt: Prompt, saved: ImageAttachmentPart[]) {
  const split = splitPromptImages(prompt)
  if (split.images.length === 0) return { text: split.text, images: saved, changed: false }

  const images = [...saved]
  for (const image of split.images) {
    if (images.some((item) => item.id === image.id)) continue
    images.push(image)
  }
  return { text: split.text, images, changed: true }
}

export function serializePromptStore(value: unknown) {
  const store = value as { prompt?: ContentPart[] }
  if (!Array.isArray(store?.prompt)) return JSON.stringify(value)
  return JSON.stringify({ ...store, prompt: store.prompt.filter((part) => part.type !== "image") })
}
