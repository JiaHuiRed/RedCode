import { createClient } from "@hey-api/openapi-ts"
import { fileURLToPath } from "url"
import path from "path"
import { format, resolveConfig } from "prettier"

// 261009 Red Build and contract tests use the same generator options and SSE patch.
// Decision: docs/notes/implemented/process/2026-10-09-sdk-contract-gate.md
export async function generateSdk(input: string, output: string) {
  await createClient({
    input,
    output: {
      path: output,
      tsConfigPath: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
      clean: true,
    },
    plugins: [
      {
        name: "@hey-api/typescript",
        exportFromIndex: false,
      },
      {
        name: "@hey-api/sdk",
        instance: "OpencodeClient",
        exportFromIndex: false,
        auth: false,
        paramsStructure: "flat",
      },
      {
        name: "@hey-api/client-fetch",
        exportFromIndex: false,
        baseUrl: "http://localhost:4096",
      },
    ],
  })

  // SseFn's second generic is the iterator return type, not the endpoint error type.
  const file = path.join(output, "client/types.gen.ts")
  const source = await Bun.file(file).text()
  const patched = source.replace(
    "=> Promise<ServerSentEventsResult<TData, TError>>",
    "=> Promise<ServerSentEventsResult<TData>>",
  )
  if (patched === source) {
    throw new Error(`SseFn patch did not apply; @hey-api/openapi-ts output may have changed (${file})`)
  }
  await Bun.write(file, patched)
}

export async function formatSdkSource(source: string, filepath: string) {
  return format(source, { ...(await resolveConfig(filepath)), filepath })
}
