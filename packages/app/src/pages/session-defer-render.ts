// 261011 Red B1-c: 会话切换的延迟渲染门禁调度（审计 GUI-06）。原实现是 session.tsx
// 内联的裸 requestAnimationFrame + setTimeout——没有可取消句柄、也不校验回调是否仍
// 属于当前会话，快速 A→B→C 时旧回调会提前解除新会话的 deferRender。这里改为：
// 每次 arm 先取消上一轮未完成的调度，回调执行前再校验 key 仍是当前会话（兜住
// 「取消失效、回调已在途」的时机）；cancel 供组件卸载时清掉未完成调度。
// 两个调度边界（rAF + setTimeout）通过注入以便回归测试；timer 句柄是运行时不透明值
// （浏览器 number / Node Timeout），只经注入的调度器原样传递。
type DeferRenderOptions = {
  key: () => string
  set: (value: boolean) => void
  raf?: (callback: () => void) => number
  cancelRaf?: (handle: number) => void
  delay?: (callback: () => void) => unknown
  cancelDelay?: (handle: unknown) => void
}

export function createDeferRender(options: DeferRenderOptions) {
  const scheduleFrame = options.raf ?? requestAnimationFrame
  const unscheduleFrame = options.cancelRaf ?? cancelAnimationFrame
  const scheduleDelay = options.delay ?? ((callback: () => void) => setTimeout(callback, 0))
  const unscheduleDelay = options.cancelDelay ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  let frame: number | undefined
  let timer: unknown

  const cancel = () => {
    if (frame !== undefined) {
      unscheduleFrame(frame)
      frame = undefined
    }
    if (timer !== undefined) {
      unscheduleDelay(timer)
      timer = undefined
    }
  }

  const arm = (key: string) => {
    cancel()
    options.set(true)
    frame = scheduleFrame(() => {
      frame = undefined
      timer = scheduleDelay(() => {
        timer = undefined
        // 261011 Red: 只有仍属于 armed 时期的会话才允许解锁；旧回调不得影响新会话
        if (options.key() !== key) return
        options.set(false)
      })
    })
  }

  return { arm, cancel }
}
