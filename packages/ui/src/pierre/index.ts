import { DiffLineAnnotation, FileContents, FileDiffOptions, type SelectedLineRange } from "@pierre/diffs"
import { ComponentProps } from "solid-js"
import { lineCommentStyles } from "../components/line-comment-styles"

export type DiffProps<T = {}> = FileDiffOptions<T> & {
  before: FileContents
  after: FileContents
  annotations?: DiffLineAnnotation<T>[]
  selectedLines?: SelectedLineRange | null
  commentedLines?: SelectedLineRange[]
  onLineNumberSelectionEnd?: (selection: SelectedLineRange | null) => void
  onRendered?: () => void
  class?: string
  classList?: ComponentProps<"div">["classList"]
}

const unsafeCSS = `
[data-diff],
[data-file] {
  --diffs-bg: light-dark(var(--diffs-light-bg), var(--diffs-dark-bg));
  --diffs-bg-buffer: var(--diffs-bg-buffer-override, light-dark( color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92%, var(--diffs-mixer))));
  --diffs-bg-hover: var(--diffs-bg-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 97%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 91%, var(--diffs-mixer))));
  --diffs-bg-context: var(--diffs-bg-context-override, light-dark( color-mix(in lab, var(--diffs-bg) 98.5%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 92.5%, var(--diffs-mixer))));
  --diffs-bg-separator: var(--diffs-bg-separator-override, light-dark( color-mix(in lab, var(--diffs-bg) 96%, var(--diffs-mixer)), color-mix(in lab, var(--diffs-bg) 85%, var(--diffs-mixer))));
  --diffs-fg: light-dark(var(--diffs-light), var(--diffs-dark));
  --diffs-fg-number: var(--diffs-fg-number-override, light-dark(color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg)), color-mix(in lab, var(--diffs-fg) 65%, var(--diffs-bg))));
  --diffs-deletion-base: var(--syntax-diff-delete);
  --diffs-addition-base: var(--syntax-diff-add);
  --diffs-modified-base: var(--syntax-diff-unknown);
  /* 260831 cc 变更行的着色强度上调。原值深色档是 92%/8% —— 8% 的着色量在磨砂紫底上
     几乎读不出来，哥哥的原话是「增三行和减三行底色其实是有区别的，只是在紫色底色下
     不够明显」。一个旁证：同一份配置里 hover 态是 30%，也就是「鼠标划过」的提示比
     「这行被改了」这个事实本身还显眼四倍，主次是反的。
     行底色 8% → 16%（深色档 92→84，浅色档 98→94）；
     行号槽 15% → 26%（深色档 85→74，浅色档 91→86）—— 行号槽单独给足，才有 zcode 那种
     「整行连行号一起铺」的观感。
     只动改动行，上下文行保持不着色：正是那个反差让人一眼看到改动的形状。
     嫌重嫌轻改这四个百分数即可；pierre 还留了 --diffs-bg-*-override 可以在下游单独覆盖。 */
  --diffs-bg-deletion: var(--diffs-bg-deletion-override, light-dark( color-mix(in lab, var(--diffs-bg) 94%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 84%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-number: var(--diffs-bg-deletion-number-override, light-dark( color-mix(in lab, var(--diffs-bg) 86%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 74%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-hover: var(--diffs-bg-deletion-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-deletion-base)), color-mix(in lab, var(--diffs-bg) 75%, var(--diffs-deletion-base))));
  --diffs-bg-deletion-emphasis: var(--diffs-bg-deletion-emphasis-override, light-dark(rgb(from var(--diffs-deletion-base) r g b / 0.7), rgb(from var(--diffs-deletion-base) r g b / 0.1)));
  --diffs-bg-addition: var(--diffs-bg-addition-override, light-dark( color-mix(in lab, var(--diffs-bg) 94%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 84%, var(--diffs-addition-base))));
  --diffs-bg-addition-number: var(--diffs-bg-addition-number-override, light-dark( color-mix(in lab, var(--diffs-bg) 86%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 74%, var(--diffs-addition-base))));
  --diffs-bg-addition-hover: var(--diffs-bg-addition-hover-override, light-dark( color-mix(in lab, var(--diffs-bg) 80%, var(--diffs-addition-base)), color-mix(in lab, var(--diffs-bg) 70%, var(--diffs-addition-base))));
  --diffs-bg-addition-emphasis: var(--diffs-bg-addition-emphasis-override, light-dark(rgb(from var(--diffs-addition-base) r g b / 0.07), rgb(from var(--diffs-addition-base) r g b / 0.1)));
  --diffs-selection-base: var(--surface-warning-strong);
  --diffs-selection-border: var(--border-warning-base);
  --diffs-selection-number-fg: #1c1917;
  /* Use explicit alpha instead of color-mix(..., transparent) to avoid Safari's non-premultiplied interpolation bugs. */
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--surface-warning-base) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--surface-warning-base) r g b / 0.85)
  );
  --diffs-bg-selection-text: rgb(from var(--surface-warning-strong) r g b / 0.2);
}

:host([data-color-scheme='dark']) [data-diff],
:host([data-color-scheme='dark']) [data-file] {
  --diffs-selection-number-fg: #fdfbfb;
  --diffs-bg-selection: var(--diffs-bg-selection-override, rgb(from var(--solaris-dark-6) r g b / 0.65));
  --diffs-bg-selection-number: var(
    --diffs-bg-selection-number-override,
    rgb(from var(--solaris-dark-6) r g b / 0.85)
  );
}

[data-diff] ::selection,
[data-file] ::selection {
  background-color: var(--diffs-bg-selection-text);
}

::highlight(redcode-find) {
  background-color: rgb(from var(--surface-warning-base) r g b / 0.35);
}

::highlight(redcode-find-current) {
  background-color: rgb(from var(--surface-warning-strong) r g b / 0.55);
}

[data-diff] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-comment-selected]:not([data-selected-line]) {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-file] [data-line-annotation][data-comment-selected]:not([data-selected-line]) [data-annotation-content] {
  box-shadow: inset 0 0 0 9999px var(--diffs-bg-selection);
}

[data-diff] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-file] [data-line][data-selected-line] {
  background-color: var(--diffs-bg-selection);
  box-shadow: inset 2px 0 0 var(--diffs-selection-border);
}

[data-diff] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-file] [data-column-number][data-selected-line] {
  background-color: var(--diffs-bg-selection-number);
  color: var(--diffs-selection-number-fg);
}

[data-diff] [data-column-number][data-line-type='context'][data-selected-line],
[data-diff] [data-column-number][data-line-type='context-expanded'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-addition'][data-selected-line],
[data-diff] [data-column-number][data-line-type='change-deletion'][data-selected-line] {
  color: var(--diffs-selection-number-fg);
}

/* The deletion word-diff emphasis is stronger than additions; soften it while selected so the selection highlight reads consistently. */
[data-diff] [data-line][data-line-type='change-deletion'][data-selected-line] {
  --diffs-bg-deletion-emphasis: light-dark(
    rgb(from var(--diffs-deletion-base) r g b / 0.07),
    rgb(from var(--diffs-deletion-base) r g b / 0.1)
  );
}

[data-diff-header],
[data-diff],
[data-file] {
  [data-separator] {
    height: 24px;
  }
  [data-column-number] {
    background-color: var(--background-stronger);
    cursor: default !important;
  }

  &[data-interactive-line-numbers] [data-column-number] {
    cursor: default !important;
  }

  &[data-interactive-lines] [data-line] {
    cursor: auto !important;
  }
  [data-code] {
    overflow-x: auto !important;
    overflow-y: clip !important;
  }
}

${lineCommentStyles}

`

export function createDefaultOptions<T>(style: FileDiffOptions<T>["diffStyle"]) {
  return {
    theme: "RedCode",
    themeType: "system",
    disableLineNumbers: false,
    overflow: "wrap",
    diffStyle: style ?? "unified",
    diffIndicators: "bars",
    lineHoverHighlight: "both",
    disableBackground: false,
    expansionLineCount: 20,
    hunkSeparators: "line-info-basic",
    lineDiffType: style === "split" ? "word-alt" : "none",
    maxLineDiffLength: 1000,
    maxLineLengthForHighlighting: 1000,
    disableFileHeader: true,
    unsafeCSS,
  } as const
}

export const styleVariables = {
  "--diffs-font-family": "var(--font-family-mono)",
  "--diffs-font-size": "var(--font-size-small)",
  "--diffs-line-height": "24px",
  "--diffs-tab-size": 2,
  "--diffs-font-features": "var(--font-family-mono--font-feature-settings)",
  "--diffs-header-font-family": "var(--font-family-sans)",
  "--diffs-gap-block": 0,
  "--diffs-min-number-column-width": "4ch",
}
