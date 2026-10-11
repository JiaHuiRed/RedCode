// 261011 Red B1.1（审计 B1.1-4）：错误边界接进 gui-diagnostics——此前 error.boundary
// 只是枚举，捕获点没有任何记录，本地录制（诊断导出）看不到渲染崩溃。scope 标识边界
// 层级（app = 顶层全屏恢复页 / route = 布局内局部隔离），错误文本过统一 scrub（maskText）。
import { ErrorBoundary, type JSX } from "solid-js"
import { guiDiagnostics } from "@/context/gui-diagnostics"

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function DiagnosticErrorBoundary(props: {
  scope: "app" | "route"
  fallback: (error: unknown, reset: () => void) => JSX.Element
  children: JSX.Element
}) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => {
        // 错误态下 fallback 可能随重渲染重复触发，重复记录可容忍（崩溃罕见）
        guiDiagnostics.record("error.boundary", {
          name: props.scope,
          outcome: "error",
          detail: { message: errorText(error) },
        })
        return props.fallback(error, reset)
      }}
    >
      {props.children}
    </ErrorBoundary>
  )
}
