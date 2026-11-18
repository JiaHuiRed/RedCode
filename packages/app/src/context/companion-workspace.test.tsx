import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { flushPersistedWrites } from "@/utils/persist"
import { useCompanionWorkspace } from "./companion-workspace"
import { GlobalSDKProvider } from "./global-sdk"
import { LanguageProvider } from "./language"
import { PlatformProvider, type Platform } from "./platform"
import { ServerConnection, ServerProvider } from "./server"

async function until(check: () => boolean) {
  const deadline = Date.now() + 1_000
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Workspace did not settle")
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fixture() {
  const stored = new Map<string, string>()
  const mounted = new Set<() => void>()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const server: ServerConnection.Http = {
    type: "http",
    http: { url: `http://workspace-${crypto.randomUUID()}.invalid` },
  }
  const platform: Platform = {
    platform: "desktop",
    openLink: () => {},
    restart: async () => {},
    back: () => {},
    forward: () => {},
    notify: async () => {},
    storage: (name) => ({
      getItem: async (key) => stored.get(`${name}:${key}`) ?? null,
      setItem: async (key, value) => {
        stored.set(`${name}:${key}`, value)
      },
      removeItem: async (key) => {
        stored.delete(`${name}:${key}`)
      },
    }),
    fetch: (async (input, init) => {
      const request = new Request(input, init)
      if (new URL(request.url).pathname !== "/global/event") throw new Error(`Unexpected request: ${request.url}`)
      return new Response(
        new ReadableStream({
          start(controller) {
            if (request.signal.aborted) controller.close()
            else request.signal.addEventListener("abort", () => controller.close(), { once: true })
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      )
    }) as typeof fetch,
  }
  const mount = async () => {
    let workspace: ReturnType<typeof useCompanionWorkspace> | undefined
    const host = document.createElement("div")
    document.body.appendChild(host)
    const Probe = () => {
      workspace = useCompanionWorkspace()
      return null
    }
    const dispose = render(
      () => (
        <PlatformProvider value={platform}>
          <LanguageProvider locale="en">
            <ServerProvider defaultServer={ServerConnection.key(server)} servers={[server]} disableHealthCheck>
              <GlobalSDKProvider>
                <QueryClientProvider client={queryClient}>
                  <Probe />
                </QueryClientProvider>
              </GlobalSDKProvider>
            </ServerProvider>
          </LanguageProvider>
        </PlatformProvider>
      ),
      host,
    )
    const unmount = () => {
      if (!mounted.delete(unmount)) return
      dispose()
      host.remove()
    }
    mounted.add(unmount)
    await until(() => workspace?.ready() === true)
    return { workspace: workspace!, unmount }
  }
  return {
    mount,
    reload: async () => {
      flushPersistedWrites()
      queryClient.clear()
      return mount()
    },
    dispose: () => {
      for (const unmount of mounted) unmount()
      flushPersistedWrites()
      queryClient.clear()
    },
  }
}

describe("companion workspace across Chat mounts", () => {
  for (const action of ["clear", "assign"] as const) {
    test(`a disposed page's late draft ${action} preserves the new page's other companion draft`, async () => {
      const app = fixture()
      try {
        const previous = await app.mount()
        previous.workspace.setDraft(action === "clear" ? "first" : "default", "A's submitted task")
        previous.workspace.setDraft("second", "B's old draft")
        const response = deferred()
        const pending = response.promise.then(() => {
          if (action === "clear") previous.workspace.clearDraft("first", "A's submitted task")
          else previous.workspace.assignDraft("first")
        })

        previous.unmount()
        const current = await app.mount()
        expect(current.workspace).not.toBe(previous.workspace)
        current.workspace.select("second")
        current.workspace.setDraft("second", "B's new draft after returning to Chat")
        await until(() => current.workspace.draft("second") === "B's new draft after returning to Chat")

        response.resolve()
        await pending
        const expected = action === "clear" ? "" : "A's submitted task"
        await until(() => current.workspace.draft("first") === expected)
        expect(current.workspace.draft("second")).toBe("B's new draft after returning to Chat")
        expect(current.workspace.draft("default")).toBe("")

        current.unmount()
        const restored = await app.reload()
        expect(restored.workspace.draft("first")).toBe(expected)
        expect(restored.workspace.draft("second")).toBe("B's new draft after returning to Chat")
        expect(restored.workspace.draft("default")).toBe("")
      } finally {
        app.dispose()
      }
    })
  }
})
