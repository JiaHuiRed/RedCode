package ai.redcode.mobile

import org.json.JSONObject

data class MobilePairingPayload(
  val url: String,
  val fingerprint: String,
  val code: String,
)

object MobilePairingPayloadParser {
  private const val MAX_QR_BYTES = 2048
  private const val TYPE = "redcode-mobile-pairing"

  fun parse(value: String): MobilePairingPayload? {
    if (value.toByteArray(Charsets.UTF_8).size > MAX_QR_BYTES) return null
    val payload = runCatching { JSONObject(value) }.getOrNull() ?: return null
    if (payload.length() != 5 || payload.optString("type") != TYPE || payload.optInt("version") != 1) return null

    val endpoint = GatewayEndpointParser.parse(payload.optString("url")) ?: return null
    val code = payload.optString("code")
    if (!code.matches(Regex("[0-9]{8}"))) return null
    val fingerprint = CertificatePins.normalize(payload.optString("fingerprint")) ?: return null
    return MobilePairingPayload(endpoint.baseUrl, fingerprint, code)
  }
}
