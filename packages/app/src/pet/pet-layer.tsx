import { Show, createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { useSettings } from "@/context/settings"
import { petState } from "./pet-store"
import { resolvePet, type PetDisplay } from "./pet-state"
import { advancePetPresentation, createPetPresentation } from "./pet-lines"
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
  const [view, setView] = createStore({ now: Date.now(), hovering: false })
  const [presentation, setPresentation] = createStore(createPetPresentation())

  // 260929 Red tick 跟着开关走：enabled 翻 false 时 effect 重跑，onCleanup 清掉上一个 timer。
  // 旧实现 interval 在组件 onMount 里，<Show> 只卸内层 DOM，关宠后每秒还在 resolvePet 全量遍历。
  createEffect(() => {
    if (!settings.general.petEnabled()) return
    setView("now", Date.now())
    const timer = setInterval(() => setView("now", Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const display = createMemo(() => resolvePet(petState(), view.now))

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
      <div
        class="pet-layer"
        data-kind={display().kind}
        data-action={presentation.action}
        onMouseEnter={() => setView("hovering", true)}
        onMouseLeave={() => setView("hovering", false)}
      >
        <Show when={view.hovering}>
          <button
            type="button"
            class="pet-layer-close"
            aria-label="关闭桌宠"
            onClick={() => settings.general.setPetEnabled(false)}
          >
            ×
          </button>
        </Show>
        <Show when={presentation.line}>
          {(line) => <div class="pet-layer-bubble">{line().text}</div>}
        </Show>
        <img
          class="pet-layer-sprite"
          src={presentation.action === "coffee" ? COFFEE_IMAGE : PET_IMAGE[display().kind]}
          alt=""
          draggable={false}
          onError={(e) => {
            // 素材未就位时回落现有占位图；占位图本身缺失则隐藏，不让裂图常驻
            const img = e.currentTarget
            if (img.src.endsWith(PLACEHOLDER)) img.style.visibility = "hidden"
            else img.src = PLACEHOLDER
          }}
        />
      </div>
    </Show>
  )
}
