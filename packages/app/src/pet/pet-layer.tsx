import { Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"
import { petState } from "./pet-store"
import { resolvePet, type PetDisplay } from "./pet-state"
import "./pet-layer.css"

/**
 * Pet Layer — 赤（Q 版）的 GUI 常驻视觉层。
 *
 * 状态来源：pet-store（引擎事件归一化）。本组件只做三件事：
 * 1s tick 驱动 flash 过期与 stale 回落、开关持久化、按状态渲染图与气泡。
 * 动画克制原则（设计文档 #15）：默认 Level 0 静默，只有 permission/waiting/终态有气泡。
 */

// 260929 Red 素材占位：统一用现有透明底仓鼠图，正式 Q 版赤图（PET_ASSET_PROMPTS.md 的 13 张）
// 到位后替换 public/pet/ 下同名文件即可，本 map 不用改。
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

const PLACEHOLDER = "/hamster.png"

const BUBBLE: Partial<Record<PetDisplay["kind"], string>> = {
  permission: "这里需要你允许一下。",
  waiting: "等你回复…",
  success: "搞定。",
  error: "出错了。",
}

export function PetLayer() {
  const [settings, setSettings] = persisted({ ...Persist.global("pet") }, createStore({ enabled: true }))
  const [now, setNow] = createSignal(Date.now())
  const [hovering, setHovering] = createSignal(false)

  onMount(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    onCleanup(() => clearInterval(timer))
  })

  const display = createMemo(() => resolvePet(petState(), now()))
  const bubble = createMemo(() => BUBBLE[display().kind])

  return (
    <Show when={settings.enabled}>
      <div
        class="pet-layer"
        data-kind={display().kind}
        onMouseEnter={() => setHovering(true)}
        onMouseLeave={() => setHovering(false)}
      >
        <Show when={hovering()}>
          <button
            type="button"
            class="pet-layer-close"
            aria-label="关闭桌宠"
            onClick={() => setSettings("enabled", false)}
          >
            ×
          </button>
        </Show>
        <Show when={bubble()}>
          <div class="pet-layer-bubble">{bubble()}</div>
        </Show>
        <img
          class="pet-layer-sprite"
          src={PET_IMAGE[display().kind]}
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
