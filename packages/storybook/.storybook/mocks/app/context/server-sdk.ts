export function useServerSDK() {
  return {
    url: "http://localhost:0",
    client: {
      session: {
        get: async () => ({}),
        list: async () => [],
      },
      file: {
        list: async () => [],
      },
    },
    event: {
      on() {},
      listen: async () => () => {},
    },
  }
}
