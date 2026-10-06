// 261006 Red 从 agent.ts 单体拆出：ACP URI/path mapping（parseUri）+ edit diff 应用
// （getNewContent），均为无 Agent 私有状态的纯函数，可独立单测。
// 命中审计「ACP 下一刀」验收原则：降低 Agent 耦合 / 增加独立单测能力 / 形成协议边界。

import { applyPatch } from "diff"
import { pathToFileURL } from "url"
import * as Log from "@redcode-ai/core/util/log"

const log = Log.create({ service: "acp-agent" })

export function parseUri(
  uri: string,
): { type: "file"; url: string; filename: string; mime: string } | { type: "text"; text: string } {
  try {
    if (uri.startsWith("file://")) {
      const path = uri.slice(7)
      const name = path.split("/").pop() || path
      return {
        type: "file",
        url: uri,
        filename: name,
        mime: "text/plain",
      }
    }
    if (uri.startsWith("zed://")) {
      const url = new URL(uri)
      const path = url.searchParams.get("path")
      if (path) {
        const name = path.split("/").pop() || path
        return {
          type: "file",
          url: pathToFileURL(path).href,
          filename: name,
          mime: "text/plain",
        }
      }
    }
    return {
      type: "text",
      text: uri,
    }
  } catch {
    return {
      type: "text",
      text: uri,
    }
  }
}

export function getNewContent(fileOriginal: string, unifiedDiff: string): string | undefined {
  const result = applyPatch(fileOriginal, unifiedDiff)
  if (result === false) {
    log.error("Failed to apply unified diff (context mismatch)")
    return undefined
  }
  return result
}
