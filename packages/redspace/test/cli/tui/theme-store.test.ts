import { expect, test } from "bun:test"
import { RGBA, type TerminalColors } from "@opentui/core"

const { DEFAULT_THEMES, allThemes, addTheme, generateSystem, hasTheme, resolveTheme } =
  await import("../../../src/cli/cmd/tui/context/theme")

function terminalColors(input: Partial<TerminalColors> = {}): TerminalColors {
  return {
    palette: Array.from({ length: 256 }, (_, index) => input.palette?.[index] ?? "#eeeeee"),
    defaultBackground: input.defaultBackground ?? "#ffffff",
    defaultForeground: input.defaultForeground ?? "#eeeeee",
    cursorColor: input.cursorColor ?? "#ff9e64",
    mouseForeground: input.mouseForeground ?? null,
    mouseBackground: input.mouseBackground ?? null,
    tekForeground: input.tekForeground ?? null,
    tekBackground: input.tekBackground ?? null,
    highlightBackground: input.highlightBackground ?? "#444444",
    highlightForeground: input.highlightForeground ?? "#ffffff",
  }
}

function contrastRatio(foreground: RGBA, background: RGBA) {
  const luminance = (color: RGBA) => {
    const linear = (channel: number) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4

    return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
  }
  const first = luminance(foreground)
  const second = luminance(background)

  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

test("addTheme writes into module theme store", () => {
  const name = `plugin-theme-${Date.now()}`
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)

  expect(allThemes()[name]).toBeDefined()
})

test("addTheme keeps first theme for duplicate names", () => {
  const name = `plugin-theme-keep-${Date.now()}`
  const one = structuredClone(DEFAULT_THEMES.opencode)
  const two = structuredClone(DEFAULT_THEMES.opencode)
  one.theme.primary = "#101010"
  two.theme.primary = "#fefefe"

  expect(addTheme(name, one)).toBe(true)
  expect(addTheme(name, two)).toBe(false)

  expect(allThemes()[name]).toBeDefined()
  expect(allThemes()[name]!.theme.primary).toBe("#101010")
})

test("addTheme ignores entries without a theme object", () => {
  const name = `plugin-theme-invalid-${Date.now()}`
  expect(addTheme(name, { defs: { a: "#ffffff" } })).toBe(false)
  expect(allThemes()[name]).toBeUndefined()
})

test("hasTheme checks theme presence", () => {
  const name = `plugin-theme-has-${Date.now()}`
  expect(hasTheme(name)).toBe(false)
  expect(addTheme(name, DEFAULT_THEMES.opencode)).toBe(true)
  expect(hasTheme(name)).toBe(true)
})

test("resolveTheme returns semantic colors", () => {
  const theme = resolveTheme(DEFAULT_THEMES.opencode, "dark")
  expect(theme.colors).toBeDefined()
  expect(theme.colors.text.body).toBe(theme.text)
  expect(theme.colors.text.primary).toBe(theme.primary)
  expect(theme.colors.surface.base).toBe(theme.background)
  expect(theme.colors.status.error).toBe(theme.error)
  expect(theme.colors.diff.added).toBe(theme.diffAdded)
  expect(theme.colors.markdown.heading).toBe(theme.markdownHeading)
  expect(theme.colors.syntax.comment).toBe(theme.syntaxComment)
})

test("resolveTheme rejects circular color refs", () => {
  const item = structuredClone(DEFAULT_THEMES.opencode)
  item.defs = {
    ...item.defs,
    one: "two",
    two: "one",
  }
  item.theme.primary = "one"

  expect(() => resolveTheme(item, "dark")).toThrow("Circular color reference")
})

test("resolveTheme keeps Markdown prose readable on light and dark surfaces", () => {
  for (const input of [
    { mode: "light" as const, background: "#ffffff", foreground: "#eeeeee" },
    { mode: "dark" as const, background: "#111111", foreground: "#222222" },
  ]) {
    const item = structuredClone(DEFAULT_THEMES.opencode)
    item.theme.background = input.background
    item.theme.text = input.foreground
    item.theme.markdownText = input.foreground
    item.theme.markdownLink = input.foreground
    item.theme.markdownCode = input.foreground

    const theme = resolveTheme(item, input.mode)

    expect(contrastRatio(theme.text, theme.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(theme.markdownText, theme.background)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(theme.markdownLink, theme.background)).toBeGreaterThanOrEqual(4.5)
    expect(theme.markdownCode.toInts()).toEqual(RGBA.fromHex(input.foreground).toInts())
  }
})

test("generateSystem keeps Markdown prose readable against the detected terminal background", () => {
  const generated = generateSystem(
    terminalColors({
      palette: Array.from({ length: 256 }, () => "#eeeeee"),
      defaultBackground: "#ffffff",
      defaultForeground: "#eeeeee",
    }),
    "light",
  )
  const background = RGBA.fromHex("#ffffff")

  for (const color of [
    generated.theme.text,
    generated.theme.markdownText,
    generated.theme.markdownLink,
    generated.theme.markdownBlockQuote,
  ]) {
    expect(color).toBeInstanceOf(RGBA)
    if (!(color instanceof RGBA)) throw new Error("expected a generated RGBA color")
    expect(contrastRatio(color, background)).toBeGreaterThanOrEqual(4.5)
  }
})

test("resolveTheme leaves transparent-background Markdown colors to the terminal theme", () => {
  const item = structuredClone(DEFAULT_THEMES.opencode)
  item.theme.background = "transparent"
  item.theme.markdownLink = "#eeeeee"

  const theme = resolveTheme(item, "light")

  expect(theme.markdownLink.toInts()).toEqual(RGBA.fromHex("#eeeeee").toInts())
})
