const disposers = new Set<(directory: string) => Promise<void>>()

export function registerDisposer(disposer: (directory: string) => Promise<void>) {
  disposers.add(disposer)
  return () => {
    disposers.delete(disposer)
  }
}

// 260607 Red add timeout to prevent doctor/dispose from hanging forever
const DISPOSE_TIMEOUT_MS = 5_000

export async function disposeInstance(directory: string) {
  const disposerList = [...disposers]
  if (disposerList.length === 0) return
  try {
    await Promise.race([
      Promise.allSettled(disposerList.map((disposer) => disposer(directory))),
      new Promise<void>((resolve) => setTimeout(() => resolve(), DISPOSE_TIMEOUT_MS)),
    ])
  } catch (error) {
    console.error("[dispose] error", error)
  }
}
