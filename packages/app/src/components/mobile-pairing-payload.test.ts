import { expect, test } from "bun:test"
import { mobilePairingPayload } from "./mobile-pairing-payload"

test("encodes only the URL, one-time code, and certificate fingerprint", () => {
  expect(
    JSON.parse(
      mobilePairingPayload({
        url: "https://192.168.1.20:4312",
        pairingCode: "01234567",
        fingerprint: "ab".repeat(32),
      }),
    ),
  ).toEqual({
    type: "redcode-mobile-pairing",
    version: 1,
    url: "https://192.168.1.20:4312",
    code: "01234567",
    fingerprint: "ab".repeat(32),
  })
})
