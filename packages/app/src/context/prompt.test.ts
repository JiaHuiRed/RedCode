import { describe, expect, test } from "bun:test"
import type { ImageAttachmentPart, Prompt } from "./prompt"
import {
  mergePromptImages,
  migratePromptImages,
  samePromptImages,
  serializePromptStore,
  splitPromptImages,
} from "./prompt-persistence"

const text = { type: "text" as const, content: "draft", start: 0, end: 5 }
const image: ImageAttachmentPart = {
  type: "image",
  id: "image-1",
  filename: "diagram.png",
  mime: "image/png",
  dataUrl: "data:image/png;base64,AAAA",
  size: 3,
  path: "C:/session/.attachments/image.png",
}

describe("prompt image draft persistence", () => {
  test("keeps image payload out of the text draft while splitting it for media storage", () => {
    const prompt: Prompt = [text, image]
    const split = splitPromptImages(prompt)
    const persisted = JSON.parse(serializePromptStore({ prompt })) as { prompt: Prompt }

    expect(split.text).toEqual([text])
    expect(split.images).toEqual([image])
    expect(persisted.prompt).toEqual([text])
    expect(JSON.stringify(persisted)).not.toContain(image.dataUrl)
  })

  test("recombines saved images with the text draft", () => {
    expect(mergePromptImages([text], [image])).toEqual([text, image])
  })

  test("migrates images from a legacy text draft into media storage", () => {
    const migration = migratePromptImages([text, image], [])

    expect(migration).toEqual({ text: [text], images: [image], changed: true })
    expect(migratePromptImages([text], [image])).toEqual({ text: [text], images: [image], changed: false })
  })

  test("only treats changed attachment identities as a media-store update", () => {
    expect(samePromptImages([image], [{ ...image }])).toBe(true)
    expect(samePromptImages([image], [])).toBe(false)
    expect(samePromptImages([image], [{ ...image, id: "image-2" }])).toBe(false)
  })
})
