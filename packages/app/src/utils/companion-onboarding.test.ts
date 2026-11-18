import { describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/solid-query"
import { companionAcceptedKey, recordCompanionMessageAccepted } from "./companion-onboarding"

describe("Chat personalization eligibility", () => {
  test("only a bound Chat submission becomes eligible", () => {
    const client = new QueryClient()
    recordCompanionMessageAccepted(client, "server-a", { mode: "code", companionID: "partner" })
    expect(client.getQueryData(companionAcceptedKey("server-a", "partner"))).toBeUndefined()
    recordCompanionMessageAccepted(client, "server-a", { mode: "chat" })
    expect(client.getQueryCache().getAll()).toHaveLength(0)
    recordCompanionMessageAccepted(client, "server-a", { mode: "chat", companionID: "partner" })
    expect(client.getQueryData<boolean>(companionAcceptedKey("server-a", "partner")) === true).toBe(true)
    expect(client.getQueryData(companionAcceptedKey("server-b", "partner"))).toBeUndefined()
    expect(client.getQueryData(companionAcceptedKey("server-a", "another"))).toBeUndefined()
    client.clear()
  })
})
