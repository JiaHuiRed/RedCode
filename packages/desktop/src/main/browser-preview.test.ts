import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { request } from "node:http"
import { closeBrowserPreview, openHtmlPreview } from "./browser-preview"

function capture() {
  const urls: string[] = []
  return { urls, deps: { openExternal: (url: string) => void urls.push(url) } }
}

function fetchPreview(url: string, method = "GET", body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>(
    (resolve, reject) => {
      const req = request(url, { method }, (res) => {
        const chunks: Buffer[] = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        )
      })
      req.on("error", reject)
      if (body !== undefined) req.write(body)
      req.end()
    },
  )
}

afterEach(async () => {
  await closeBrowserPreview()
})

describe("desktop browser preview", () => {
  test("serves the HTML document back from a loopback URL", async () => {
    const opened = capture()
    const html = '<!doctype html><meta charset="utf-8"><title>HTML preview</title><p>中文 &amp; "quoted"</p>'

    await openHtmlPreview(html, opened.deps)
    expect(opened.urls).toHaveLength(1)
    const url = opened.urls[0]!
    expect(url.startsWith("http://127.0.0.1:")).toBe(true)
    expect(new URL(url).hostname).toBe("127.0.0.1")

    const res = await fetchPreview(url)
    expect(res.status).toBe(200)
    expect(res.body).toBe(html)
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(res.headers["cache-control"]).toBe("no-store")
    expect(res.headers["x-content-type-options"]).toBe("nosniff")
    expect(res.headers["referrer-policy"]).toBe("no-referrer")
    expect(res.headers["content-security-policy"]).toBe("sandbox allow-scripts")

    const head = await fetchPreview(url, "HEAD")
    expect(head.status).toBe(200)
    expect(head.body).toBe("")
  })

  test("returns 404 for guessed or malformed tokens", async () => {
    const opened = capture()
    await openHtmlPreview("<p>secret</p>", opened.deps)
    const url = opened.urls[0]!
    const origin = new URL(url).origin

    for (const guess of [`${origin}/`, `${origin}/guess`, `${url}x`, `${url}/extra`]) {
      expect((await fetchPreview(guess)).status).toBe(404)
    }
  })

  test("rejects writes and leaves the document unchanged", async () => {
    const opened = capture()
    await openHtmlPreview("<p>read only</p>", opened.deps)
    const url = opened.urls[0]!

    const post = await fetchPreview(url, "POST", "<p>overwrite</p>")
    expect(post.status).toBe(405)
    expect(post.headers["allow"]).toBe("GET, HEAD")
    expect((await fetchPreview(url)).body).toBe("<p>read only</p>")
  })

  test("rejects documents beyond the per-document budget without opening a browser", async () => {
    const opened = capture()

    await expect(openHtmlPreview("a".repeat(5 * 1024 * 1024 + 1), opened.deps)).rejects.toThrow(/too large/)
    expect(opened.urls).toHaveLength(0)
  })

  test("drops documents after the ten minute window", async () => {
    const opened = capture()
    await openHtmlPreview("<p>short lived</p>", opened.deps)
    const url = opened.urls[0]!

    try {
      setSystemTime(new Date(Date.now() + 11 * 60 * 1000))
      expect((await fetchPreview(url)).status).toBe(404)
    } finally {
      setSystemTime()
    }
  })

  test("keeps at most eight documents", async () => {
    const opened = capture()
    for (let index = 0; index < 9; index += 1) await openHtmlPreview(`<p>doc ${index}</p>`, opened.deps)

    expect(opened.urls).toHaveLength(9)
    expect((await fetchPreview(opened.urls[0]!)).status).toBe(404)
    expect((await fetchPreview(opened.urls[8]!)).status).toBe(200)
  })

  test("keeps the cache under the total byte budget", async () => {
    const opened = capture()
    const chunk = "a".repeat(5 * 1024 * 1024 - 1)

    for (let index = 0; index < 4; index += 1) await openHtmlPreview(`${chunk}${index}`, opened.deps)

    expect((await fetchPreview(opened.urls[0]!)).status).toBe(404)
    expect((await fetchPreview(opened.urls[2]!)).status).toBe(200)
    expect((await fetchPreview(opened.urls[3]!)).status).toBe(200)
  })

  test("shares one listening server across concurrent opens", async () => {
    const opened = capture()
    await Promise.all([
      openHtmlPreview("<p>one</p>", opened.deps),
      openHtmlPreview("<p>two</p>", opened.deps),
    ])

    expect(opened.urls).toHaveLength(2)
    expect(new URL(opened.urls[0]!).port).toBe(new URL(opened.urls[1]!).port)
    expect((await fetchPreview(opened.urls[0]!)).body).toBe("<p>one</p>")
    expect((await fetchPreview(opened.urls[1]!)).body).toBe("<p>two</p>")
  })

  test("recovers when the browser handoff fails", async () => {
    await expect(
      openHtmlPreview("<p>retry</p>", {
        openExternal: () => {
          throw new Error("no browser")
        },
      }),
    ).rejects.toThrow("no browser")

    const opened = capture()
    await expect(openHtmlPreview("<p>retry</p>", opened.deps)).resolves.toBeUndefined()
    expect((await fetchPreview(opened.urls[0]!)).body).toBe("<p>retry</p>")
  })
})
