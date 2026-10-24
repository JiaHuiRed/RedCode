import { Schema } from "effect"
import { decode64 } from "@/utils/base64"

// 261024 Red 从 pages/directory-layout.tsx 归位：目录参数的品牌类型与解码是纯工具，
// 被 titlebar（components/）与 session-side-panel 消费，不该住在页面组件文件里。
export const ProjectDirString = Schema.String.pipe(Schema.brand("ProjectDirString"))
export type ProjectDirString = Schema.Schema.Type<typeof ProjectDirString>

export function decodeDirectory(dir: string): ProjectDirString | undefined {
  const decoded = decode64(dir)
  if (!decoded) return
  return ProjectDirString.make(decoded)
}
