import { afterEach, describe, expect, test } from "bun:test"
import { resource } from "@redcode-ai/core/effect/observability"

const otelResourceAttributes = process.env.OTEL_RESOURCE_ATTRIBUTES
const redcodeClient = process.env.REDCODE_CLIENT

afterEach(() => {
  if (otelResourceAttributes === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES
  else process.env.OTEL_RESOURCE_ATTRIBUTES = otelResourceAttributes

  if (redcodeClient === undefined) delete process.env.REDCODE_CLIENT
  else process.env.REDCODE_CLIENT = redcodeClient
})

describe("resource", () => {
  test("parses and decodes OTEL resource attributes", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES =
      "service.namespace=JiaHuiRed,team=platform%2Cobservability,label=hello%3Dworld,key%2Fname=value%20here"

    expect(resource().attributes).toMatchObject({
      "service.namespace": "JiaHuiRed",
      team: "platform,observability",
      label: "hello=world",
      "key/name": "value here",
    })
  })

  test("drops OTEL resource attributes when any entry is invalid", () => {
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.namespace=JiaHuiRed,broken"

    expect(resource().attributes["service.namespace"]).toBeUndefined()
    expect(resource().attributes["redcode.client"]).toBeDefined()
  })

  test("keeps built-in attributes when env values conflict", () => {
    process.env.REDCODE_CLIENT = "cli"
    process.env.OTEL_RESOURCE_ATTRIBUTES = "redcode.client=web,service.instance.id=override,service.namespace=JiaHuiRed"

    expect(resource().attributes).toMatchObject({
      "redcode.client": "cli",
      "service.namespace": "JiaHuiRed",
    })
    expect(resource().attributes["service.instance.id"]).not.toBe("override")
  })
})
