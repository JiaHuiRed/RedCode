// 261011 Red B1.1（审计 B1.1-4）：错误边界局部隔离的渲染测试——子组件崩溃被边界捕获
// 且不影响边界外内容；reset 后子树恢复；崩溃进入 gui-diagnostics（error.boundary）。
import { afterEach, describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { guiDiagnostics } from "@/context/gui-diagnostics"
import { DiagnosticErrorBoundary } from "./diagnostic-error-boundary"

describe("DiagnosticErrorBoundary", () => {
  afterEach(() => guiDiagnostics.stop())

  test("子组件崩溃被隔离：边界外内容仍在、fallback 显示、记录 error.boundary", () => {
    guiDiagnostics.start()
    const container = document.createElement("div")
    document.body.appendChild(container)
    const Boom = () => {
      throw new Error("boom in child")
    }
    const dispose = render(
      () => (
        <div>
          <span data-testid="sibling">sibling alive</span>
          <DiagnosticErrorBoundary
            scope="route"
            fallback={(error) => <span data-testid="fallback">{String((error as Error).message)}</span>}
          >
            <Boom />
          </DiagnosticErrorBoundary>
        </div>
      ),
      container,
    )
    try {
      expect(container.querySelector('[data-testid="sibling"]')?.textContent).toBe("sibling alive")
      expect(container.querySelector('[data-testid="fallback"]')?.textContent).toBe("boom in child")
      const records = guiDiagnostics.payload().records.filter((record) => record.type === "error.boundary")
      expect(records).toHaveLength(1)
      expect(records[0]).toMatchObject({ name: "route", outcome: "error" })
      expect(records[0]?.detail?.message).toBe("boom in child")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("reset 后子树恢复渲染", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const [shouldThrow, setShouldThrow] = createSignal(true)
    const MaybeBoom = () => {
      if (shouldThrow()) throw new Error("boom")
      return <span data-testid="recovered">recovered</span>
    }
    let reset: (() => void) | undefined
    const dispose = render(
      () => (
        <DiagnosticErrorBoundary
          scope="route"
          fallback={(_error, r) => {
            reset = r
            return <span data-testid="fallback">failed</span>
          }}
        >
          <MaybeBoom />
        </DiagnosticErrorBoundary>
      ),
      container,
    )
    try {
      expect(container.querySelector('[data-testid="fallback"]')).not.toBeNull()
      setShouldThrow(false)
      reset?.()
      expect(container.querySelector('[data-testid="recovered"]')?.textContent).toBe("recovered")
      expect(container.querySelector('[data-testid="fallback"]')).toBeNull()
    } finally {
      dispose()
      container.remove()
    }
  })
})
