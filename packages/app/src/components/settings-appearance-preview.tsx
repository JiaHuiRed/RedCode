import { createMemo, untrack, Show } from "solid-js"
import { Button } from "@redcode-ai/ui/button"
import { useLanguage } from "@/context/language"
import { terminalFontFamily, useSettings } from "@/context/settings"

// 261115 Red UX-20 外观实时样例：消息/代码/终端三块紧凑样例，与主界面同一套来源——
// 字体与字号走 root 上的 --font-family-sans/--font-family-mono 与 --font-size-*
// （settings.tsx 的 createEffect 写入），CSS 变量一变样例跟着重绘，不需要 JS 重渲染；
// 终端字体走 terminalFontFamily()（terminal.tsx 给 xterm 的同一取值路径）；壁纸与遮罩
// 复用 [data-wallpaper-veil] 规则和同一个 --frost-alpha-veil 变量。上方任何外观行调整，
// 样例即时反映，不用反复关闭设置去主界面确认可读性。
export function AppearanceSamples() {
  const language = useLanguage()
  const settings = useSettings()

  // 「撤销本次外观改动」的基准：本组件挂载（设置打开）那一刻的外观值。只恢复
  // 外观分区的键，其他分区配置不受影响。
  const snapshot = untrack(() => ({
    sans: settings.appearance.uiFont(),
    mono: settings.appearance.font(),
    terminal: settings.appearance.terminalFont(),
    fontSize: settings.appearance.fontSize(),
    chatBackground: settings.appearance.chatBackground(),
    homeBackground: settings.appearance.homeBackground(),
    wallpaperDim: settings.appearance.wallpaperDim(),
  }))

  const changed = createMemo(
    () =>
      settings.appearance.uiFont() !== snapshot.sans ||
      settings.appearance.font() !== snapshot.mono ||
      settings.appearance.terminalFont() !== snapshot.terminal ||
      settings.appearance.fontSize() !== snapshot.fontSize ||
      settings.appearance.chatBackground() !== snapshot.chatBackground ||
      settings.appearance.homeBackground() !== snapshot.homeBackground ||
      settings.appearance.wallpaperDim() !== snapshot.wallpaperDim,
  )

  const restore = () => {
    settings.appearance.setUIFont(snapshot.sans)
    settings.appearance.setFont(snapshot.mono)
    settings.appearance.setTerminalFont(snapshot.terminal)
    settings.appearance.setFontSize(snapshot.fontSize)
    settings.appearance.setChatBackground(snapshot.chatBackground)
    settings.appearance.setHomeBackground(snapshot.homeBackground)
    settings.appearance.setWallpaperDim(snapshot.wallpaperDim)
  }

  const labelClass = "text-11-regular text-text-weaker"
  // 消息/代码样例跟随 --font-size-base（基准 14px 按设置等比缩放）；行高对齐
  // 正文阅读的宽松档，中文与代码在同一字号档下的密度差异当场可比。
  const bodyStyle = {
    "font-size": "var(--font-size-base)",
    "line-height": "1.7",
  } as const

  return (
    <div class="mt-3 flex flex-col gap-2" data-component="settings-appearance-preview">
      <div class="flex items-center justify-between">
        <div class="text-12-medium text-text-weak">{language.t("settings.general.preview.title")}</div>
        <Show when={changed()}>
          <Button data-action="settings-appearance-undo" variant="ghost" size="small" onClick={restore}>
            {language.t("settings.general.preview.undo")}
          </Button>
        </Show>
      </div>
      <div
        class="relative overflow-hidden rounded-lg border border-border-weaker-base bg-cover bg-center bg-no-repeat"
        style={{
          // 与 layout.tsx 同名变量：壁纸遮罩滑杆拖动，样例区的压暗即时变化
          "--frost-alpha-veil": `${settings.appearance.wallpaperDim()}%`,
          ...(settings.appearance.chatBackground()
            ? { "background-image": `url(${settings.appearance.chatBackground()})` }
            : {}),
        }}
      >
        <Show when={settings.appearance.chatBackground()}>
          <div aria-hidden="true" data-wallpaper-veil class="pointer-events-none absolute inset-0" />
        </Show>
        {/* 宽容器三块并排，窄容器按 min-width 换行到控件下方 */}
        <div class="relative z-[1] flex flex-wrap gap-3 p-3">
          <div class="flex min-w-[200px] flex-1 flex-col gap-1.5">
            <div class={labelClass}>{language.t("settings.general.preview.message")}</div>
            <div class="rounded-md bg-surface-base px-3 py-2" style={bodyStyle}>
              <span style={{ "font-family": "var(--font-family-sans)" }}>
                {language.t("settings.general.preview.messageBody")}
              </span>
            </div>
          </div>
          <div class="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <div class={labelClass}>{language.t("settings.general.preview.code")}</div>
            <pre
              class="overflow-hidden rounded-md bg-surface-base px-3 py-2 whitespace-pre"
              style={{
                ...bodyStyle,
                "font-family": "var(--font-family-mono)",
                "font-feature-settings": "var(--font-family-mono--font-feature-settings)",
              }}
            >
              <span style={{ color: "var(--syntax-keyword)" }}>{"const "}</span>
              <span style={{ color: "var(--syntax-string)" }}>{"sum = (a, b) => a + b"}</span>
              {"\n"}
              <span style={{ color: "var(--text-weaker)" }}>{"// 中文注释与代码同色系"}</span>
              {"\n"}
              <span style={{ color: "var(--syntax-info)" }}>{"return "}</span>
              <span style={{ color: "var(--text-strong)" }}>{"sum(1, 2)"}</span>
            </pre>
          </div>
          <div class="flex min-w-[220px] flex-1 flex-col gap-1.5">
            <div class={labelClass}>{language.t("settings.general.preview.terminal")}</div>
            <div
              class="overflow-hidden rounded-md bg-background-stronger px-3 py-2 whitespace-pre"
              style={{
                ...bodyStyle,
                // 只跟随终端字体设置；界面字体调整不影响这一块
                "font-family": terminalFontFamily(settings.appearance.terminalFont()),
              }}
            >
              <span style={{ color: "var(--syntax-info)" }}>{"$ bun test src/session"}</span>
              {"\n"}
              <span style={{ color: "var(--syntax-success)" }}>{"✓ 42 pass"}</span>
              <span style={{ color: "var(--text-weak)" }}>{" 0 fail (320ms)"}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
