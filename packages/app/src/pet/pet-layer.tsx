import { Show, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Portal } from "solid-js/web"
import { useSettings } from "@/context/settings"
import { petState } from "./pet-store"
import { DEFAULT_OUTFIT, outfitFor, resolvePet, type PetDisplay } from "./pet-state"
import {
  advancePetPresentation,
  clampPetPixels,
  clampPetPosition,
  createPetPresentation,
  petBubblePlacement,
  petPositionFromOffset,
  petStroke,
  petTouchAt,
  petTouchIsExpired,
  petTouchResponse,
  type PetTouch,
} from "./pet-lines"
import "./pet-layer.css"

/**
 * Pet Layer — 赤（Q 版）的 GUI 常驻视觉层。
 *
 * 状态来源：pet-store（引擎事件归一化）。本组件只做表现层：
 * 1s tick 驱动 flash 过期与 stale 回落、按状态渲染图与台词、hover 关闭钮。
 * 动画克制原则（设计文档 #15）：默认 Level 0 静默，只有 permission/waiting/终态有常驻台词。
 *
 * 260929 Red 两处修（第三方审计复检）：
 *   ① 开关挪进 settings.general.petEnabled——旧实现自持 Persist.global("pet") 键，
 *      × 写 false 后整层消失且全仓没有第二个入口能开回来；现在设置页可管。
 *    ② tick 从 onMount 改为 createEffect 门控——关宠后 interval 随之清理，
 *      不再每秒空转 setNow → resolvePet。
 *
 * 261006 Red V0.2（参考 crosspet 的本地台词池与闲时动作）：
 *   台词从每态一句固定文案换成 pet-lines.ts 的随机池——必说姿态进态即说、
 *   干活姿态概率 + 冷却低频碎碎念；新增 idle 闲时动作调度（咖啡用收编的
 *   02-idle-coffee.png），任何工作态立即让位。
 */

// 素材在 public/pet/ 下按状态命名；onError 回落 hamster.png 兜底（缺图不裂图）
const PET_IMAGE: Record<PetDisplay["kind"], string> = {
  idle: "/pet/01-idle-look.png",
  thinking: "/pet/03-thinking.png",
  coding: "/pet/05-coding.png",
  searching: "/pet/06-searching.png",
  tool: "/pet/07-terminal-tool.png",
  waiting: "/pet/10-waiting.png",
  permission: "/pet/09-permission.png",
  compacting: "/pet/13-compacting.png",
  success: "/pet/11-success.png",
  error: "/pet/12-error.png",
}

// 261006 Red 闲时动作帧：接入已有的 02-idle-coffee 素材。
const COFFEE_IMAGE = "/pet/02-idle-coffee.png"

const PLACEHOLDER = "/hamster.png"

export function PetLayer() {
  const settings = useSettings()
  const [view, setView] = createStore({
    now: Date.now(),
    touch: undefined as PetTouch | undefined,
    touchUntil: undefined as number | undefined,
    dragging: false,
    viewport: { width: 0, height: 0 },
    position: { left: 0, top: 0, ready: false },
    rootSize: { width: 0, height: 0 },
    bubbleSize: { width: 0, height: 0 },
  })
  const [presentation, setPresentation] = createStore(createPetPresentation())
  let root: HTMLDivElement | undefined
  let bubble: HTMLDivElement | undefined
  let body: HTMLButtonElement | undefined
  let geometryObserver: ResizeObserver | undefined
  let drag: {
    id: number
    startX: number
    startY: number
    offsetX: number
    offsetY: number
    moved: boolean
    startLeft: number
    startTop: number
  } | undefined
  let lastTouchAt: number | undefined
  let lastPointer: { x: number; y: number } | undefined
  let suppressClickTarget: EventTarget | undefined
  const applyPosition = (left: number, top: number, persist: boolean) => {
    const bounded = clampPetPixels(left, top, view.rootSize.width, view.rootSize.height, window.innerWidth, window.innerHeight)
    setView("position", { left: bounded.left, top: bounded.top, ready: true })
    if (!persist || !window.innerWidth || !window.innerHeight) return
    settings.general.setPetPosition(petPositionFromOffset(bounded.left, bounded.top, window.innerWidth, window.innerHeight))
  }

  const measure = () => {
    if (!root) return
    const rect = root.getBoundingClientRect()
    setView("viewport", { width: window.innerWidth, height: window.innerHeight })
    setView("rootSize", { width: rect.width, height: rect.height })
    if (bubble) {
      // 261021 Red 入场缩放不改变布局盒；按布局尺寸夹边，避免把动画中的小宽度一直当成气泡宽度。
      setView("bubbleSize", { width: bubble.offsetWidth, height: bubble.offsetHeight })
    }
    const saved = settings.general.petPosition()
    const left = drag
      ? view.position.ready ? view.position.left : rect.left
      : saved ? saved.x * window.innerWidth : (view.position.ready ? view.position.left : rect.left)
    const top = drag
      ? view.position.ready ? view.position.top : rect.top
      : saved ? saved.y * window.innerHeight : (view.position.ready ? view.position.top : rect.top)
    applyPosition(left, top, false)
  }

  const setRootRef = (node: HTMLDivElement) => {
    root = node
    geometryObserver?.observe(node)
    measure()
  }

  const setBubbleRef = (node: HTMLDivElement) => {
    bubble = node
    geometryObserver?.observe(node)
    measure()
  }

  const resetInteraction = () => {
    setView("touch", undefined)
    setView("touchUntil", undefined)
    setPresentation("line", (line) => line?.until !== undefined ? undefined : line)
    lastTouchAt = undefined
    lastPointer = undefined
    root?.style.removeProperty("--pet-stroke")
  }

  const respondToTouch = (kind: PetTouch) => {
    const now = Date.now()
    const response = petTouchResponse(display().kind, lastTouchAt, now, settings.general.petBehavior(), kind)
    setView("touch", kind)
    setView("touchUntil", now + settings.general.petBehavior().touchResponseMs)
    setPresentation("action", undefined)
    setPresentation("actionUntil", undefined)
    if (display().kind === "idle") setPresentation("idleDue", now + settings.general.petBehavior().idleIntervalMs)
    if (!response) return
    lastTouchAt = now
    setPresentation("line", response)
  }

  const handlePointerDown = (event: PointerEvent) => {
    suppressClickTarget = undefined
    lastPointer = undefined
    setView("touch", undefined)
    setView("touchUntil", undefined)
    root?.style.removeProperty("--pet-stroke")
    if (!event.isPrimary || event.button !== 0 || (event.target as Element).closest(".pet-layer-close")) return
    const rect = root!.getBoundingClientRect()
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
      startLeft: rect.left,
      startTop: rect.top,
    }
    body!.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) {
      const current = drag
      const dx = event.clientX - current.startX
      if (!current.moved && Math.hypot(dx, event.clientY - current.startY) >= 6) {
        current.moved = true
        setView("dragging", true)
      }
      if (current.moved) {
        const position = petPositionFromOffset(event.clientX - current.offsetX, event.clientY - current.offsetY, window.innerWidth, window.innerHeight)
        const bounded = clampPetPosition(position, view.rootSize.width, view.rootSize.height, window.innerWidth, window.innerHeight)
        setView("position", {
          left: bounded.x * window.innerWidth,
          top: bounded.y * window.innerHeight,
          ready: true,
        })
        root?.style.setProperty("--pet-stroke", String(petStroke(dx, view.rootSize.width)))
      }
      return
    }
    const moved = !lastPointer || lastPointer.x !== event.clientX || lastPointer.y !== event.clientY
    const dx = lastPointer ? event.clientX - lastPointer.x : 0
    lastPointer = { x: event.clientX, y: event.clientY }
    if (event.buttons !== 0 || !moved || !root) return
    const rect = root.getBoundingClientRect()
    const area = petTouchAt((event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height)
    if (area) {
      respondToTouch(area)
      root.style.setProperty("--pet-stroke", String(petStroke(dx, view.rootSize.width)))
    }
    else {
      setView("touch", undefined)
      setView("touchUntil", undefined)
      root.style.removeProperty("--pet-stroke")
    }
  }

  const finishDrag = (event: PointerEvent, cancelled: boolean) => {
    const current = drag
    if (!current || current.id !== event.pointerId) return
    drag = undefined
    setView("dragging", false)
    lastPointer = undefined
    setView("touch", undefined)
    setView("touchUntil", undefined)
    root?.style.removeProperty("--pet-stroke")
    if (body?.hasPointerCapture(event.pointerId)) body.releasePointerCapture(event.pointerId)
    if (cancelled) {
      setView("position", { left: current.startLeft, top: current.startTop, ready: true })
      return
    }
    if (!current.moved) return
    suppressClickTarget = body
    applyPosition(view.position.left, view.position.top, true)
  }

  const handleClick = (event: MouseEvent) => {
    if (suppressClickTarget === event.currentTarget) {
      suppressClickTarget = undefined
      if (event.detail !== 0) return
    }
    respondToTouch("head")
  }

  const handlePointerLeave = () => {
    lastPointer = undefined
    setView("touch", undefined)
    setView("touchUntil", undefined)
    root?.style.removeProperty("--pet-stroke")
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 40 : 16
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      respondToTouch("head")
      return
    }
    if (event.key === "Home") {
      event.preventDefault()
      settings.general.setPetPosition(undefined)
      setView("position", "ready", false)
      root?.style.removeProperty("left")
      root?.style.removeProperty("top")
      root?.style.removeProperty("right")
      root?.style.removeProperty("bottom")
      measure()
      return
    }
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key]
    if (!delta) return
    event.preventDefault()
    const rect = root!.getBoundingClientRect()
    applyPosition(rect.left + delta[0]!, rect.top + delta[1]!, true)
  }

  const bubbleLayout = createMemo(() =>
    petBubblePlacement(
      view.position.top,
      view.position.left,
      view.rootSize.width,
      view.viewport.width,
      view.bubbleSize.width,
      view.bubbleSize.height,
    ),
  )
  const bubbleLeft = createMemo(() => {
    const left = view.position.left
    const maxLeft = Math.max(16, view.viewport.width - view.bubbleSize.width - 16)
    return Math.max(16, Math.min(left, maxLeft)) - left
  })

  createEffect(() => {
    const enabled = settings.general.petEnabled()
    if (!enabled) return
    const resizeObserver = new ResizeObserver(measure)
    geometryObserver = resizeObserver
    if (root) resizeObserver.observe(root)
    if (bubble) resizeObserver.observe(bubble)
    window.addEventListener("resize", measure)
    untrack(measure)
    onCleanup(() => {
      window.removeEventListener("resize", measure)
      resizeObserver.disconnect()
      geometryObserver = undefined
      if (drag) {
        setView("position", { left: drag.startLeft, top: drag.startTop, ready: true })
        if (body?.hasPointerCapture(drag.id)) body.releasePointerCapture(drag.id)
      }
      drag = undefined
      setView("dragging", false)
    })
  })

  createEffect(() => {
    const line = presentation.line
    if (!bubble || !geometryObserver) return
    if (line) geometryObserver.observe(bubble)
    else geometryObserver.unobserve(bubble)
  })

  createEffect(() => {
    const now = view.now
    if (petTouchIsExpired(view.touchUntil, now)) {
      setView("touch", undefined)
      setView("touchUntil", undefined)
      root?.style.removeProperty("--pet-stroke")
    }
  })

  // 260929 Red tick 跟着开关走：enabled 翻 false 时 effect 重跑，onCleanup 清掉上一个 timer。
  // 旧实现 interval 在组件 onMount 里，<Show> 只卸内层 DOM，关宠后每秒还在 resolvePet 全量遍历。
  createEffect(() => {
    if (!settings.general.petEnabled()) return
    setView("now", Date.now())
    const timer = setInterval(() => setView("now", Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const display = createMemo(() => resolvePet(petState(), view.now))
  const displayKind = createMemo(() => display().kind)
  const outfit = createMemo(() => outfitFor(petState(), display().sessionID))
  const sprite = createMemo(() =>
    outfit() === DEFAULT_OUTFIT
      ? PET_IMAGE[display().kind]
      : PET_IMAGE[display().kind].replace("/pet/", `/pet/outfits/${encodeURIComponent(outfit())}/`),
  )

  createEffect(() => {
    settings.general.petEnabled()
    displayKind()
    untrack(resetInteraction)
  })

  // 261006 Red reducer 记住姿态边沿，1s tick 只收过期台词/推进闲时动作，不反复抽词。
  createEffect(() => {
    const kind = display().kind
    const enabled = settings.general.petEnabled()
    const behavior = settings.general.petBehavior()
    untrack(() =>
      setPresentation(produce((draft) => advancePetPresentation(draft, kind, enabled, Date.now(), behavior))),
    )
  })

  return (
    <Show when={settings.general.petEnabled()}>
      <Portal>
        <div
          class="pet-layer"
          ref={setRootRef}
          data-kind={display().kind}
          data-action={presentation.action}
          data-touch={view.touch}
          data-dragging={view.dragging ? "true" : "false"}
          data-bubble-placement={bubbleLayout().placement}
          data-bubble-align={bubbleLayout().align}
          style={view.position.ready
            ? { left: `${view.position.left}px`, top: `${view.position.top}px`, right: "auto", bottom: "auto" }
            : undefined}
          onPointerLeave={handlePointerLeave}
        >
          <Show when={presentation.line}>
            {(line) => (
              <div ref={setBubbleRef} class="pet-layer-bubble" role="status" aria-live="polite"
                style={{ left: `${bubbleLeft()}px`, right: "auto" }}>
                <span class="pet-layer-bubble-label">赤</span>
                <span class="pet-layer-bubble-text">{line().text}</span>
              </div>
            )}
          </Show>
          <button
            ref={body}
            type="button"
            class="pet-layer-body"
            aria-label="和赤互动"
            title="移动抚摸；拖动移动；方向键移动，Home 归位"
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={(event) => finishDrag(event, false)}
            onPointerCancel={(event) => finishDrag(event, true)}
            onLostPointerCapture={(event) => finishDrag(event, true)}
            onKeyDown={handleKeyDown}
          >
            <span class="pet-layer-figure">
              <img
                class="pet-layer-sprite"
                src={presentation.action === "coffee" ? COFFEE_IMAGE : sprite()}
                alt=""
                draggable={false}
                onLoad={measure}
                onError={(event) => {
                  const image = event.currentTarget
                  if (image.src.includes("/pet/outfits/")) image.src = PET_IMAGE[display().kind]
                  else if (image.src.endsWith(PLACEHOLDER)) image.style.visibility = "hidden"
                  else image.src = PLACEHOLDER
                }}
              />
            </span>
            <svg class="pet-layer-affection" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.5 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z" />
            </svg>
          </button>
          <button
            type="button"
            class="pet-layer-close"
            aria-label="关闭桌宠"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => settings.general.setPetEnabled(false)}
          >×</button>
        </div>
      </Portal>
    </Show>
  )
}
