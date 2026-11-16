// 261116 Red B05/B06：时间线片段定位的 DOM 观察层（纯函数 + 有界重试，能单测）。
//
// 搜索命中落在工具输出里时，时间线只展开到「工具组」还不够：组内每个工具自己的
// BasicTool 折叠默认是收起的，未挂载的 output 没有 textNode，既定位不到也高亮不了。
// 这里按「已挂载的 DOM 状态」逐层点开目标片段内部的折叠（collapsible / accordion），
// 每轮用 textContent 观测命中词是否真的出现，命中即停；只作用于目标片段，不全展开整组。
// 不假设「等一帧 DOM 就好」——每一轮都重新读取状态，帧数/展开次数都有上限。
// 决策：docs/notes/implemented/feature/2026-11-16-experience-roadmap-v2.md

export const findPartHost = (root: ParentNode, partID: string) => {
  for (const el of root.querySelectorAll<HTMLElement>("[data-timeline-part-id]")) {
    if (el.dataset.timelinePartId === partID) return el
  }
}

export const findGroupHost = (root: ParentNode, partID: string) => {
  for (const el of root.querySelectorAll<HTMLElement>("[data-timeline-part-ids]")) {
    if ((el.dataset.timelinePartIds ?? "").split(",").includes(partID)) return el
  }
}

/** 展开工具组；返回是否找到了组（已展开也算找到）。 */
export const openGroupTrigger = (group: HTMLElement) => {
  if (group.querySelector('[data-component="context-tool-group-list"]')) return true
  const trigger = group.querySelector<HTMLElement>('[data-component="context-tool-group-trigger"]')
  if (!trigger) return false
  trigger.click()
  return true
}

/** 目标工具自身的折叠根（BasicTool 的 tool-collapsible）。 */
export const toolBodyTrigger = (host: HTMLElement) => {
  const body = host.querySelector<HTMLElement>('[data-component="collapsible"].tool-collapsible')
  return body?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]')
}

/** 片段内部仍未展开的折叠触发器；链接型触发器（task/文件入口）不点，避免导航。 */
export const collapsedTriggers = (host: HTMLElement) => {
  const result: HTMLElement[] = []
  for (const el of host.querySelectorAll<HTMLElement>(
    '[data-slot="collapsible-trigger"], [data-slot="accordion-trigger"]',
  )) {
    if (el.tagName === "A") continue
    if (el.getAttribute("aria-expanded") === "true") continue
    result.push(el)
  }
  return result
}

/** 命中词是否已出现在真实正文里；换行/空白差异按折叠后比较。 */
export const textMounted = (host: HTMLElement, query?: string) => {
  if (!query) return true
  const text = host.textContent ?? ""
  if (text.includes(query)) return true
  return text.replace(/\s+/g, " ").includes(query.replace(/\s+/g, " "))
}

const expanded = (trigger: HTMLElement) =>
  trigger.getAttribute("aria-expanded") === "true" || trigger.tagName === "A"

export type RevealWithinHostInput = {
  host: () => HTMLElement | undefined
  query?: string
  frame: () => Promise<void>
  onFound?: (host: HTMLElement) => void
  maxFrames?: number
  maxExpands?: number
}

/**
 * 在目标片段内按需展开，直到命中词出现在已挂载正文里（无命中词时只展开工具自身正文，
 * 供 B06「返回工具」恢复阅读现场）。返回是否找到并展开了目标内容。
 */
export async function revealWithinHost(input: RevealWithinHostInput) {
  const clicked = new Set<HTMLElement>()
  let expands = 0
  const maxFrames = input.maxFrames ?? 90
  const maxExpands = input.maxExpands ?? 12
  for (let frame = 0; frame < maxFrames; frame++) {
    const host = input.host()
    if (!host) {
      await input.frame()
      continue
    }

    // ① 目标工具自身的正文折叠：命中/返回都要按需展开一次。
    const body = toolBodyTrigger(host)
    if (body && !clicked.has(body) && !expanded(body)) {
      clicked.add(body)
      expands += 1
      body.click()
      await input.frame()
      continue
    }

    // ② 有命中词时继续点开内层折叠（如 apply_patch 的单文件项），命中即停。
    if (input.query && !textMounted(host, input.query) && expands < maxExpands) {
      const next = collapsedTriggers(host).find((el) => !clicked.has(el))
      if (next) {
        clicked.add(next)
        expands += 1
        next.click()
        await input.frame()
        continue
      }
    }

    if (!textMounted(host, input.query)) {
      await input.frame()
      continue
    }
    input.onFound?.(host)
    return true
  }
  return false
}

/** rAF 观测一拍；窗口被遮挡时 rAF 不回调，用等长兜底避免跳转锁死。 */
export const nextFrame = () =>
  new Promise<void>((resolve) => {
    let settled = false
    let frame: number
    let timer: ReturnType<typeof setTimeout>
    const finish = () => {
      if (settled) return
      settled = true
      cancelAnimationFrame(frame)
      clearTimeout(timer)
      resolve()
    }
    frame = requestAnimationFrame(finish)
    timer = setTimeout(finish, 120)
  })
