import { Show, createEffect, createMemo, on, onCleanup, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { Portal } from "solid-js/web"
import { usePlatform } from "@/context/platform"
import { useSettings } from "@/context/settings"
import { useServerSync } from "@/context/server-sync"
import { pathKey } from "@/utils/path-key"
import { petState } from "./pet-store"
import { DEFAULT_OUTFIT, outfitFor, resolvePet, resolveSessionPet, type PetDisplay } from "./pet-state"
import {
  advancePetPresentation,
  clampPetPixels,
  clampPetPosition,
  createPetPresentation,
  petBubblePlacement,
  petDetail,
  petStatus,
  petPositionFromOffset,
  petStroke,
  petTouchAt,
  petTouchIsExpired,
  petTouchResponse,
  type PetBehavior,
  type PetTouch,
} from "./pet-lines"
import type { DesktopPetLayout } from "./desktop-pet"
import "./pet-layer.css"

export type { DesktopPetBridge, DesktopPetLayout, DesktopPetSnapshot } from "./desktop-pet"

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
 *
 * 261118 Red 桌面原生窗拆分：
 *   表现层收成纯 props 的 PetView（桌面渲染进程没有 settings/server-sync 上下文），
 *   本组件保留会话快照与开关，只在 platform.desktopPet 存在时把
 *   {kind, outfit, behavior} 推给主进程；原生窗确认接管后卸掉内联 DOM。
 *   接口契约见 src/pet/desktop-pet.ts。
 */

// 素材在 public/pet/ 下按状态命名；onError 回落 hamster.png 兜底（缺图不裂图）
const PET_IMAGE: Record<PetDisplay["kind"], string> = {
  idle: "/pet/01-idle-look.png",
  unknown: "/pet/01-idle-look.png",
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

// 261006 Red 闲时动作帧：接入已有的 02-idle-coffee.png 素材。
const COFFEE_IMAGE = "/pet/02-idle-coffee.png"

const PLACEHOLDER = "/hamster.png"

// 261118 Red 原生窗命中面：主进程按这两个目标决定 setIgnoreMouseEvents。
const NATIVE_INTERACTIVE = ".pet-layer-hotspot,.pet-layer-close"

export type PetViewProps = {
  enabled?: boolean
  display: PetDisplay
  outfit: string
  behavior: PetBehavior
  scope?: string
  onClose: () => void
  /** 内联模式的位置读写（浏览器）；原生模式由 native.layout 接管。 */
  inlinePosition?: {
    get: () => { x: number; y: number } | undefined
    set: (position: { x: number; y: number } | undefined) => void
  }
  /** 原生窗口模式：位置由主进程给出，拖动只上报阶段，命中检测上报穿透开关。 */
  native?: {
    layout: DesktopPetLayout
    drag: (phase: "start" | "move" | "end" | "cancel") => void
    hit: (interactive: boolean) => void
  }
}

/**
 * 261118 Red 纯表现层：赤的姿态/台词/交互，不读 settings 或 server-sync。
 * 浏览器由 PetLayer 喂会话快照；桌面原生窗由主进程快照重建 display。
 */
export function PetView(props: PetViewProps) {
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
  let interactive: boolean | undefined

  const enabled = () => props.enabled ?? true
  // 原生窗没有视口拖动，位置全部来自主进程 layout；内联模式沿用旧坐标系。
  const positionLeft = () => (props.native ? props.native.layout.left : view.position.left)
  const positionTop = () => (props.native ? props.native.layout.top : view.position.top)

  const applyPosition = (left: number, top: number, persist: boolean) => {
    const bounded = clampPetPixels(left, top, view.rootSize.width, view.rootSize.height, window.innerWidth, window.innerHeight)
    setView("position", { left: bounded.left, top: bounded.top, ready: true })
    if (props.native || !persist || !window.innerWidth || !window.innerHeight) return
    props.inlinePosition?.set(petPositionFromOffset(bounded.left, bounded.top, window.innerWidth, window.innerHeight))
  }

  const measure = () => {
    if (!root?.isConnected) return
    const rect = root.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    setView("viewport", { width: window.innerWidth, height: window.innerHeight })
    setView("rootSize", { width: rect.width, height: rect.height })
    if (bubble) {
      // 261021 Red 入场缩放不改变布局盒；按布局尺寸夹边，避免把动画中的小宽度一直当成气泡宽度。
      setView("bubbleSize", { width: bubble.offsetWidth, height: bubble.offsetHeight })
    }
    if (props.native) return
    const saved = props.inlinePosition?.get()
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

  const setInteractive = (value: boolean) => {
    const native = props.native
    if (!native || interactive === value) return
    interactive = value
    native.hit(value)
  }

  const pointerOverInteractive = (event: PointerEvent) => {
    if (typeof document.elementFromPoint !== "function") return false
    return !!document.elementFromPoint(event.clientX, event.clientY)?.closest(NATIVE_INTERACTIVE)
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
    const response = petTouchResponse(props.display.kind, lastTouchAt, now, props.behavior, kind)
    setView("touch", kind)
    setView("touchUntil", now + props.behavior.touchResponseMs)
    setPresentation("action", undefined)
    setPresentation("actionUntil", undefined)
    if (props.display.kind === "idle") setPresentation("idleDue", now + props.behavior.idleIntervalMs)
    if (!response) return
    lastTouchAt = now
    setPresentation("line", response)
  }

  const finishDrag = (cancelled: boolean) => {
    const current = drag
    if (!current) return
    drag = undefined
    setView("dragging", false)
    lastPointer = undefined
    setView("touch", undefined)
    setView("touchUntil", undefined)
    root?.style.removeProperty("--pet-stroke")
    if (body?.hasPointerCapture(current.id)) body.releasePointerCapture(current.id)
    // 261118 Red 原生窗：end/cancel 必发，主进程据此释放抓取（没拖动也算）。
    props.native?.drag(cancelled ? "cancel" : "end")
    if (cancelled) {
      if (!props.native) setView("position", { left: current.startLeft, top: current.startTop, ready: true })
      return
    }
    if (!current.moved) return
    suppressClickTarget = body
    if (!props.native) applyPosition(view.position.left, view.position.top, true)
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
    // 261118 Red 主进程要真实的按下点，start 必须在 pointerdown 就发；
    // 按住期间命中面保持可交互，否则拖到窗口外会中途变穿透。
    props.native?.drag("start")
    setInteractive(true)
  }

  const handlePointerMove = (event: PointerEvent) => {
    if (drag?.id === event.pointerId) {
      const current = drag
      const dx = event.clientX - current.startX
      if (!current.moved && Math.hypot(dx, event.clientY - current.startY) >= 6) {
        current.moved = true
        setView("dragging", true)
      }
      if (!current.moved) return
      props.native?.drag("move")
      if (!props.native) {
        const position = petPositionFromOffset(event.clientX - current.offsetX, event.clientY - current.offsetY, window.innerWidth, window.innerHeight)
        const bounded = clampPetPosition(position, view.rootSize.width, view.rootSize.height, window.innerWidth, window.innerHeight)
        setView("position", {
          left: bounded.x * window.innerWidth,
          top: bounded.y * window.innerHeight,
          ready: true,
        })
      }
      root?.style.setProperty("--pet-stroke", String(petStroke(dx, view.rootSize.width)))
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
    // 261118 Red 原生窗的窗口位置归主进程，键盘移动/归位只在浏览器内联层生效。
    if (props.native) return
    if (event.key === "Home") {
      event.preventDefault()
      props.inlinePosition?.set(undefined)
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

  const bubbleLayout = createMemo(() => {
    const computed = petBubblePlacement(
      positionTop(),
      positionLeft(),
      view.rootSize.width,
      view.viewport.width,
      view.bubbleSize.width,
      view.bubbleSize.height,
    )
    // 261118 Red 原生窗的气泡朝上/朝下由主进程按屏幕边缘决定，横向对齐仍按窗口内空间算。
    return props.native ? { placement: props.native.layout.placement, align: computed.align } : computed
  })
  const bubbleLeft = createMemo(() => {
    const left = positionLeft()
    const maxLeft = Math.max(16, view.viewport.width - view.bubbleSize.width - 16)
    return Math.max(16, Math.min(left, maxLeft)) - left
  })

  createEffect(() => {
    if (!enabled()) return
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
        if (!props.native) setView("position", { left: drag.startLeft, top: drag.startTop, ready: true })
        if (body?.hasPointerCapture(drag.id)) body.releasePointerCapture(drag.id)
      }
      drag = undefined
      setView("dragging", false)
    })
  })

  createEffect(() => {
    const line = presentation.line || petDetail(props.display)
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
    if (!enabled()) return
    setView("now", Date.now())
    const timer = setInterval(() => setView("now", Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const sprite = createMemo(() =>
    props.outfit === DEFAULT_OUTFIT
      ? PET_IMAGE[props.display.kind]
      : PET_IMAGE[props.display.kind].replace("/pet/", `/pet/outfits/${encodeURIComponent(props.outfit)}/`),
  )

  createEffect(() => {
    enabled()
    props.display.kind
    untrack(resetInteraction)
  })

  // 261006 Red reducer 记住姿态边沿，1s tick 只收过期台词/推进闲时动作，不反复抽词。
  // 261118 Red tick 显式进依赖：原生窗的 display 不会每秒换对象，
  // 旧写法（靠 display 对象每秒重建触发）会让台词永不过期、闲时动作不再触发。
  let presentationScope: string | undefined
  createEffect(on(
    () => [props.display.kind, enabled(), props.behavior, props.scope ?? "", view.now] as const,
    ([kind, active, behavior, scope]) =>
      untrack(() =>
        setPresentation(produce((draft) => {
          if (presentationScope !== scope) {
            presentationScope = scope
            draft.enabled = false
            draft.line = undefined
            draft.action = undefined
            draft.actionUntil = undefined
          }
          advancePetPresentation(draft, kind, active, Date.now(), behavior)
        })),
      ),
  ))

  // 261118 Red 原生窗穿透开关：Electron 透传的鼠标事件只到 DOM，主进程看不到像素，
  // 所以由渲染层按命中面（hotspot/close）回报；按住期间保持可交互，避免拖动中途丢事件。
  createEffect(() => {
    const native = props.native
    if (!native || !enabled()) return
    const move = (event: PointerEvent) => {
      if (drag) return setInteractive(true)
      setInteractive(pointerOverInteractive(event))
    }
    const leave = (event: MouseEvent) => {
      if (drag || event.relatedTarget) return
      setInteractive(false)
    }
    const blur = () => {
      finishDrag(true)
      setInteractive(false)
    }
    document.addEventListener("pointermove", move, true)
    window.addEventListener("mouseout", leave)
    window.addEventListener("blur", blur)
    setInteractive(false)
    onCleanup(() => {
      document.removeEventListener("pointermove", move, true)
      window.removeEventListener("mouseout", leave)
      window.removeEventListener("blur", blur)
      interactive = undefined
      native.hit(false)
    })
  })

  return (
    <Show when={enabled()}>
      <Portal>
        <div
          class="pet-layer"
          ref={setRootRef}
          data-kind={props.display.kind}
          data-action={presentation.action}
          data-touch={view.touch}
          data-dragging={view.dragging ? "true" : "false"}
          data-native={props.native ? "true" : undefined}
          data-bubble-placement={bubbleLayout().placement}
          data-bubble-align={bubbleLayout().align}
          style={props.native
            ? { left: `${props.native.layout.left}px`, top: `${props.native.layout.top}px`, right: "auto", bottom: "auto" }
            : view.position.ready
              ? { left: `${view.position.left}px`, top: `${view.position.top}px`, right: "auto", bottom: "auto" }
              : undefined}
          onPointerLeave={handlePointerLeave}
        >
          <Show when={presentation.line || petDetail(props.display)}>
              <div ref={setBubbleRef} class="pet-layer-bubble" role="status" aria-live="polite"
                style={{ left: `${bubbleLeft()}px`, right: "auto" }}>
                <span class="pet-layer-bubble-label">赤</span>
                <span class="pet-layer-bubble-text">{presentation.line?.text}{presentation.line && petDetail(props.display) ? " · " : ""}{petDetail(props.display)}</span>
              </div>
          </Show>
          <span class="pet-layer-status" role="status" aria-live="polite">{petStatus(props.display.kind)}</span>
          <button
            ref={body}
            type="button"
            class="pet-layer-body"
            aria-label="和赤互动"
            title={props.native ? "移动抚摸；拖动移动" : "移动抚摸；拖动移动；方向键移动，Home 归位"}
            onClick={handleClick}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={() => finishDrag(false)}
            onPointerCancel={() => finishDrag(true)}
            onLostPointerCapture={() => finishDrag(true)}
            onKeyDown={handleKeyDown}
          >
            {/* 261114 Red 唯一命中面（见 pet-layer.css）：透明空白穿透底层控件，事件仍冒泡回按钮 */}
            <span class="pet-layer-hotspot" aria-hidden="true" />
            <span class="pet-layer-figure">
              <img
                class="pet-layer-sprite"
                src={presentation.action === "coffee" ? COFFEE_IMAGE : sprite()}
                alt=""
                draggable={false}
                onLoad={measure}
                onError={(event) => {
                  const image = event.currentTarget
                  if (image.src.includes("/pet/outfits/")) image.src = PET_IMAGE[props.display.kind]
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
            onClick={() => props.onClose()}
          >×</button>
        </div>
      </Portal>
    </Show>
  )
}

/**
 * 浏览器内联桌宠：会话快照（server-sync）、开关与位置持久化由本组件持有，
 * 表现全部交给 PetView。桌面平台存在 desktopPet 桥时，快照推给原生窗并在确认接管后卸掉内联 DOM。
 */
export function PetLayer(props: { sessionID?: string; directory?: string }) {
  const settings = useSettings()
  const sync = useServerSync()
  const platform = usePlatform()
  const [view, setView] = createStore({ now: Date.now() })
  const [native, setNative] = createStore({ active: false })

  // 260929 Red tick 跟着开关走：关宠后不再每秒 resolvePet。
  createEffect(() => {
    if (!settings.general.petEnabled()) return
    setView("now", Date.now())
    const timer = setInterval(() => setView("now", Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const display = createMemo(() => {
    const sessionID = props.sessionID
    if (!sessionID) return resolvePet(petState(), view.now)
    const directory = props.directory
    const child = directory ? sync.peek(directory, { bootstrap: false })[0] : undefined
    return resolveSessionPet(petState(), view.now, sessionID, child && {
      status: child.session_status_ready ? child.session_status[sessionID] : undefined,
      statusReady: child.session_status_ready,
      permissions: child.permission[sessionID],
      questions: child.question[sessionID],
    }, directory ? pathKey(directory) : undefined)
  })
  const kind = createMemo(() => display().kind)
  const outfit = createMemo(() => outfitFor(petState(), display().sessionID))
  const scope = createMemo(() => `${props.directory ?? ""}\0${props.sessionID ?? ""}`)
  const inlinePosition = {
    get: () => settings.general.petPosition(),
    set: (position: { x: number; y: number } | undefined) => settings.general.setPetPosition(position),
  }

  // 261118 Red 只在桌面桥存在时才走原生窗：设置未就绪不推（避免默认值闪一次），
  // 关闭推 null；in-flight 结果用 token 去重，避免旧 Promise 把新状态改回去。
  let publishToken = 0
  createEffect(() => {
    const bridge = platform.desktopPet
    if (!bridge) return
    if (!settings.ready()) return
    const snapshot = settings.general.petEnabled()
      ? { kind: kind(), outfit: outfit(), behavior: settings.general.petBehavior() }
      : null
    const token = ++publishToken
    void bridge.update(snapshot).then(
      (shown) => {
        if (token === publishToken) setNative("active", shown)
      },
      () => {
        if (token === publishToken) setNative("active", false)
      },
    )
  })

  createEffect(() => {
    if (!settings.general.petEnabled()) setNative("active", false)
  })

  createEffect(() => {
    const bridge = platform.desktopPet
    if (!bridge) return
    const off = bridge.onClosed(() => {
      setNative("active", false)
      settings.general.setPetEnabled(false)
    })
    onCleanup(off)
  })

  onCleanup(() => {
    publishToken++
    void platform.desktopPet?.update(null).catch((error) => console.warn("Could not release desktop pet", error))
  })

  return (
    <Show when={!native.active}>
      <PetView
        enabled={settings.general.petEnabled()}
        display={display()}
        outfit={outfit()}
        behavior={settings.general.petBehavior()}
        scope={scope()}
        onClose={() => settings.general.setPetEnabled(false)}
        inlinePosition={inlinePosition}
      />
    </Show>
  )
}
