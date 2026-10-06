import { createStore } from "solid-js/store"

const [data, setData] = createStore({
  session_todo: {} as Record<string, Array<{ id: string; title: string; status: string }>>,
  mcp: {} as Record<string, { tools: Array<{ name: string }> }>,
  lsp: {} as Record<string, unknown>,
})

export function useServerSync() {
  return {
    data,
    set(...input: unknown[]) {
      ;(setData as (...args: unknown[]) => void)(...input)
    },
    todo: {
      set(sessionID: string, todos: Array<{ id: string; title: string; status: string }>) {
        setData("session_todo", sessionID, todos)
      },
    },
  }
}

export function useQueryOptions() {
  return {
    agents: (directory: string) => ({
      queryKey: [directory, "agents"],
      queryFn: async () => [],
    }),
    mcp: (directory: string) => ({
      queryKey: [directory, "mcp"],
      queryFn: async () => ({ tools: [] }),
    }),
    lsp: (directory: string) => ({
      queryKey: [directory, "lsp"],
      queryFn: async () => [],
    }),
  }
}

export function loadMcpQuery() {
  return { queryKey: ["mcp"], queryFn: async () => ({ tools: [] }) }
}

export function loadLspQuery() {
  return { queryKey: ["lsp"], queryFn: async () => [] }
}
