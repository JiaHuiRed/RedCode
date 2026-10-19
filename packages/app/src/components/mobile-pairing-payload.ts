export type MobilePairingInfo = {
  url: string
  pairingCode: string
  fingerprint: string
}

export function mobilePairingPayload(info: MobilePairingInfo) {
  return JSON.stringify({
    type: "redcode-mobile-pairing",
    version: 1,
    url: info.url,
    code: info.pairingCode,
    fingerprint: info.fingerprint,
  })
}
