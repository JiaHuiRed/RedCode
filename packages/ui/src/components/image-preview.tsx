import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createSignal, Show } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

// 260703 Red 单张预览（向后兼容）
export interface ImagePreviewProps {
  src: string
  alt?: string
}

// 260703 Red 多张预览，支持左右切换
export interface ImageGalleryPreviewProps {
  images: { src: string; alt?: string }[]
  initialIndex?: number
}

export function ImagePreview(props: ImagePreviewProps | ImageGalleryPreviewProps) {
  const i18n = useI18n()
  const images = () => "images" in props ? props.images : [{ src: props.src, alt: (props as ImagePreviewProps).alt }]
  const [index, setIndex] = createSignal("initialIndex" in props ? (props as ImageGalleryPreviewProps).initialIndex ?? 0 : 0)
  const current = () => images()[index()]
  const hasPrev = () => index() > 0
  const hasNext = () => index() < images().length - 1
  const total = () => images().length

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft" && hasPrev()) { e.stopPropagation(); setIndex((i) => i - 1) }
    if (e.key === "ArrowRight" && hasNext()) { e.stopPropagation(); setIndex((i) => i + 1) }
  }

  return (
    <div data-component="image-preview" onKeyDown={onKeyDown}>
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <Show when={total() > 1}>
              <span data-slot="image-preview-counter">
                {index() + 1} / {total()}
              </span>
            </Show>
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body">
            <Show when={hasPrev()}>
              <button
                type="button"
                data-slot="image-preview-nav-prev"
                onClick={() => setIndex((i) => i - 1)}
              >
                <IconButton icon="chevron-left" variant="ghost" size="large" as="span" />
              </button>
            </Show>
            <img
              src={current()?.src}
              alt={current()?.alt ?? i18n.t("ui.imagePreview.alt")}
              data-slot="image-preview-image"
            />
            <Show when={hasNext()}>
              <button
                type="button"
                data-slot="image-preview-nav-next"
                onClick={() => setIndex((i) => i + 1)}
              >
                <IconButton icon="chevron-left" variant="ghost" size="large" as="span" style={{ transform: "rotate(180deg)" }} />
              </button>
            </Show>
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
