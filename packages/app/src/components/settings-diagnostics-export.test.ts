import { describe, expect, test } from "bun:test"
import { DiagnosticsExportError, exportDiagnostics } from "./settings-diagnostics-export"

describe("settings diagnostics export", () => {
  test("does not report a bundle until the archive has completed", async () => {
    let finish: (path: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      finish = resolve
    })
    let completed = false
    const result = exportDiagnostics("preview payload", {
      save: async (payload) => {
        expect(payload).toBe("preview payload")
        return "/logs/gui-diagnostics.json"
      },
      archive: () => pending,
      download: () => {
        throw new Error("Unexpected browser download")
      },
    }).then((value) => {
      completed = true
      return value
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    finish("/downloads/diagnostics.zip")
    expect(await result).toEqual({ kind: "bundle", path: "/downloads/diagnostics.zip" })
  })

  test("keeps the saved diagnostic path when archive export fails", async () => {
    const result = await exportDiagnostics("{}", {
      save: async () => "/logs/gui-diagnostics.json",
      archive: async () => {
        throw new Error("Disk is full")
      },
      download: () => {
        throw new Error("Unexpected browser download")
      },
    }).catch((error: unknown) => error)
    expect(result).toBeInstanceOf(DiagnosticsExportError)
    expect((result as DiagnosticsExportError).message).toBe("Disk is full")
    expect((result as DiagnosticsExportError).savedPath).toBe("/logs/gui-diagnostics.json")
  })

  test("falls back to a browser download when no desktop file was written", async () => {
    const payloads: string[] = []
    expect(
      await exportDiagnostics("same preview", {
        save: async () => null,
        archive: async () => {
          throw new Error("Unexpected archive export")
        },
        download: (payload) => {
          payloads.push(payload)
        },
      }),
    ).toEqual({ kind: "download" })
    expect(payloads).toEqual(["same preview"])
  })
})
