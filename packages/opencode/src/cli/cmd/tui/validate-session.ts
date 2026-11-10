import { createOpencodeClient } from "@redcode-ai/sdk/v2"
import { SessionID } from "@/session/schema"
import { Schema } from "effect"
import { Filesystem } from "@/util/filesystem"

const decodeSessionID = Schema.decodeUnknownSync(SessionID)

// 261110 Red 只校验会话 ID 存在不够：服务端可能按自己的默认实例路由，打开的是别的项目的会话。
// 拿到会话后必须核对 directory，不一致就明确报错，绝不通过中间件把请求路由到其他项目。
function sameDirectory(a: string, b: string) {
  const normalize = (value: string) => Filesystem.resolve(value).replaceAll("\\", "/").replace(/\/+$/, "")
  const left = normalize(a)
  const right = normalize(b)
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export async function validateSession(input: {
  url: string
  sessionID?: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
}) {
  if (!input.sessionID) return

  let sessionID: SessionID
  try {
    sessionID = decodeSessionID(input.sessionID)
  } catch (error) {
    throw new Error(`Invalid session ID: ${error instanceof Error ? error.message : "unknown error"}`, { cause: error })
  }

  const session = await createOpencodeClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  })
    .session.get({ sessionID }, { throwOnError: true })
    .then((result) => result.data)

  if (!input.directory || !session?.directory) return
  if (sameDirectory(session.directory, input.directory)) return
  throw new Error(
    `Session ${sessionID} belongs to ${session.directory}, not ${input.directory}. ` +
      `Start the TUI from that directory or drop --session to open it there.`,
  )
}
