import { createMemo, type Setter } from "solid-js"
import { useKV } from "./kv"

export type 思考中Mode = "show" | "hide"

const MODES: readonly 思考中Mode[] = ["show", "hide"] as const

// OpenAI's Responses API surfaces reasoning summaries that start with a bolded
// title line: "**Inspecting PR workflow**\n\n<body>". GitHub Copilot routes
// through the same shape, and the redcode provider relays it too. Pull the
// title out for a nicer label; return null for providers that don't follow
// this convention so the caller can fall back to a generic "思考中" string.
export function reasoningTitle(text: string): string | null {
  const match = text.trimStart().match(/^\*\*([^*\n]+)\*\*/)
  return match ? match[1].trim() : null
}

export function is思考中Mode(value: unknown): value is 思考中Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
}

// Cycle order matches the slash command: show → hide → show.
export function next思考中Mode(current: 思考中Mode): 思考中Mode {
  const idx = MODES.indexOf(current)
  return MODES[(idx + 1) % MODES.length] ?? "show"
}

export function use思考中Mode() {
  const kv = useKV()
  // Capture pre-state before `kv.signal` seeds a default, so we can detect
  // first-time users with a legacy `thinking_visibility` boolean and migrate.
  // The KVProvider only renders children once kv.ready, so reads here are safe.
  const hadStored = kv.get("thinking_mode") !== undefined
  const legacy = kv.get("thinking_visibility")
  const [stored, setStored] = kv.signal<思考中Mode>("thinking_mode", "hide")

  // The kv signal exposes its setter typed as `Setter<T>` which carries Solid's
  // overload set; passing an updater fn through a property access loses the
  // bivariance trick the existing `setX((prev) => ...)` callsites rely on.
  // Wrap it in a sane shape so consumers can just call `set(next)` or pass
  // an updater.
  const set = (next: 思考中Mode | ((prev: 思考中Mode) => 思考中Mode)) => {
    if (typeof next === "function") setStored(next as Setter<思考中Mode>)
    else setStored(() => next)
  }

  // Preserve previous experience for users who had explicitly toggled the
  // legacy `thinking_visibility` boolean. First-time users (no legacy key)
  // get the new "hide" default (collapsed thinking).
  if (!hadStored) {
    if (legacy === true) set("show")
    else if (legacy === false) set("hide")
  }

  if ((stored() as string) === "minimal") set("hide")

  const mode = createMemo<思考中Mode>(() => {
    const value = stored()
    return is思考中Mode(value) ? value : "hide"
  })

  return {
    mode,
    set,
  }
}
