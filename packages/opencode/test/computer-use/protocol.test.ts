import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import {
  ActionOutcome,
  Observation,
  ObservationBarrier,
  canMutate,
  createObservationBarrier,
} from "../../src/computer-use/protocol"

const observation = {
  id: "observation-1",
  timestamp: 1_758_320_000_000,
  focusedWindow: "RedCode",
  screen: "primary",
  width: 1920,
  height: 1080,
  screenshot: {
    id: PartID.ascending(),
    sessionID: SessionID.descending(),
    messageID: MessageID.ascending(),
    type: "file" as const,
    mime: "image/png",
    filename: "desktop.png",
    url: "data:image/png;base64,AA==",
  },
}

describe("computer-use protocol", () => {
  test("observation carries a stable identity and durable screenshot part", () => {
    const decoded = Schema.decodeUnknownSync(Observation)(observation)

    expect(decoded.id).toBe("observation-1")
    expect(decoded.screenshot.filename).toBe("desktop.png")
  })

  test("action outcomes distinguish confirmed and ambiguous execution", () => {
    expect(
      Schema.decodeUnknownSync(ActionOutcome)({
        status: "confirmed",
        observationInvalidated: true,
      }),
    ).toEqual({
      status: "confirmed",
      observationInvalidated: true,
    })
    expect(
      Schema.decodeUnknownSync(ActionOutcome)({
        status: "ambiguous",
        observationInvalidated: true,
      }),
    ).toEqual({
      status: "ambiguous",
      observationInvalidated: true,
    })
  })

  test("mutation requires the current observation and no barrier", () => {
    expect(
      canMutate({
        observation,
        expectedObservationId: "observation-1",
        focusedWindow: "RedCode",
        screen: "primary",
      }),
    ).toBe(true)
    expect(canMutate({ observation, expectedObservationId: "observation-old" })).toBe(false)
    expect(
      canMutate({
        observation,
        expectedObservationId: "observation-1",
        focusedWindow: "Other App",
        screen: "primary",
      }),
    ).toBe(false)

    const barrier = createObservationBarrier("ambiguous")
    expect(Schema.decodeUnknownSync(ObservationBarrier)(barrier)).toEqual(barrier)
    expect(
      canMutate({
        observation,
        expectedObservationId: "observation-1",
        focusedWindow: "RedCode",
        screen: "primary",
        barrier,
      }),
    ).toBe(false)
  })
})
