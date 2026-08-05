import { MetaProvider } from "@solidjs/meta"
import { render } from "solid-js/web"
import "@redcode-ai/app/index.css"
import { Font } from "@redcode-ai/ui/font"
import { Splash } from "@redcode-ai/ui/logo"
import { Progress } from "@redcode-ai/ui/progress"
import "./styles.css"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import type { InitStep, SqliteMigrationProgress } from "../preload/types"

const root = document.getElementById("root")!
const lines = ["Just a moment...", "Migrating your database", "This may take a couple of minutes"]
const delays = [3000, 9000]

render(() => {
  const [step, setStep] = createSignal<InitStep | null>(null)
  const [line, setLine] = createSignal(0)
  const [percent, setPercent] = createSignal(0)
  const [visible, setVisible] = createSignal(false)

  const phase = createMemo(() => step()?.phase)

  const value = createMemo(() => {
    if (phase() === "done") return 100
    return Math.max(25, Math.min(100, percent()))
  })

  window.api.awaitInitialization((next) => setStep(next as InitStep)).catch(() => undefined)

  onMount(() => {
    setLine(0)
    setPercent(0)
    requestAnimationFrame(() => setVisible(true))

    const timers = delays.map((ms, i) => setTimeout(() => setLine(i + 1), ms))

    const listener = window.api.onSqliteMigrationProgress((progress: SqliteMigrationProgress) => {
      if (progress.type === "InProgress") setPercent(Math.max(0, Math.min(100, progress.value)))
      if (progress.type === "Done") {
        setPercent(100)
        setStep({ phase: "done" })
      }
    })

    onCleanup(() => {
      listener()
      timers.forEach(clearTimeout)
    })
  })

  createEffect(() => {
    if (phase() !== "done") return

    const timer = setTimeout(() => window.api.loadingWindowComplete(), 1000)
    onCleanup(() => clearTimeout(timer))
  })

  const status = createMemo(() => {
    if (phase() === "done") return "All done"
    if (phase() === "sqlite_waiting") return lines[line()]
    return "Just a moment..."
  })

  return (
    <MetaProvider>
      <div class="w-screen h-screen bg-background-base flex items-center justify-center">
        <Font />
        <style>{`
          @keyframes loading-fade-in {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
          }
          @keyframes loading-pulse {
            0%, 100% { opacity: 0.15; }
            50% { opacity: 0.25; }
          }
          .loading-logo {
            animation: loading-pulse 3s ease-in-out infinite;
          }
          .loading-content {
            opacity: 0;
            transition: opacity 0.6s ease-out;
          }
          .loading-content.visible {
            opacity: 1;
          }
          .loading-text {
            animation: loading-fade-in 0.5s ease-out;
          }
          .loading-progress-track {
            transition: width 0.3s ease-out;
          }
        `}</style>
        <div class="flex flex-col items-center gap-11">
          <Splash class={`w-20 h-25 loading-logo ${visible() ? "opacity-20" : "opacity-0"}`} />
          <div class={`w-60 flex flex-col items-center gap-4 loading-content ${visible() ? "visible" : ""}`} aria-live="polite">
            <span class="loading-text w-full overflow-hidden text-center text-ellipsis whitespace-nowrap text-text-strong text-14-normal">
              {status()}
            </span>
            <Progress
              value={value()}
              class="w-20 [&_[data-slot='progress-track']]:h-1 [&_[data-slot='progress-track']]:border-0 [&_[data-slot='progress-track']]:rounded-none [&_[data-slot='progress-track']]:bg-surface-weak [&_[data-slot='progress-fill']]:rounded-none [&_[data-slot='progress-fill']]:bg-icon-warning-base loading-progress-track"
              aria-label="Database migration progress"
              getValueLabel={({ value }) => `${Math.round(value)}%`}
            />
          </div>
        </div>
      </div>
    </MetaProvider>
  )
}, root)
