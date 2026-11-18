import type { PetBehavior } from "./pet-lines"
import type { PetDisplay } from "./pet-state"

/**
 * 261118 Red 桌面原生桌宠窗的桥类型（App 侧契约，桌面主进程与之对齐）。
 *
 * 只传表现层需要的三个标量——sessionID/tool/detail 这类会话元数据不上线，
 * 原生窗口按 kind 取姿态与固定台词池，不接触任何会话正文。
 */
export type DesktopPetSnapshot = {
  kind: PetDisplay["kind"]
  outfit: string
  behavior: PetBehavior
}

/** 原生窗已经算好的摆放结果（窗口内坐标 + 气泡朝上/朝下）。 */
export type DesktopPetLayout = {
  left: number
  top: number
  placement: "above" | "below"
}

export type DesktopPetBridge = {
  /** 推送快照并请求原生窗显隐；false = 原生窗不可用，GUI 保留内联桌宠。 */
  update(snapshot: DesktopPetSnapshot | null): Promise<boolean>
  /** 订阅原生窗被关闭（× 或系统行为），返回退订函数。 */
  onClosed(listener: () => void): () => void
}
