import type { DesktopPetLayout, DesktopPetSnapshot } from "@redcode-ai/ui/desktop-pet"

export type PetDrag = "start" | "move" | "end" | "cancel"
export type PetScene = { snapshot: DesktopPetSnapshot; layout: DesktopPetLayout }
export type PetWindowAPI = {
  ready(): void
  onScene(listener: (scene: PetScene) => void): () => void
  hit(interactive: boolean): void
  drag(phase: PetDrag): void
  close(): void
}
