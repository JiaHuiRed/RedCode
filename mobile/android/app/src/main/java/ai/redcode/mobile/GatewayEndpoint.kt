package ai.redcode.mobile

import java.net.URI
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.Locale

data class GatewayEndpoint(
  val baseUrl: String,
  val host: String,
  val port: Int,
)

object GatewayEndpointParser {
  fun parse(value: String): GatewayEndpoint? {
    val uri = runCatching { URI(value.trim()) }.getOrNull() ?: return null
    if (uri.scheme?.lowercase(Locale.ROOT) != "https") return null
    if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
    if (uri.rawPath !in listOf("", "/")) return null

    val host = uri.host?.lowercase(Locale.ROOT) ?: return null
    val port = uri.port
    if (port !in 1..65535 || !isPrivateHost(host)) return null
    return GatewayEndpoint("https://$host:$port", host, port)
  }

  fun sessionUrl(endpoint: GatewayEndpoint, directory: String, sessionID: String): String? {
    if (directory.isBlank() || directory.toByteArray(StandardCharsets.UTF_8).size > 8192) return null
    if (!sessionID.matches(Regex("ses_[A-Za-z0-9_-]{1,128}"))) return null
    val encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(directory.toByteArray(StandardCharsets.UTF_8))
    return "${endpoint.baseUrl}/$encoded/session/$sessionID"
  }

  private fun isPrivateHost(host: String): Boolean {
    if (host == "localhost" || host == "127.0.0.1") return true
    val octets = host.split(".").map { it.toIntOrNull() ?: return false }
    if (octets.size != 4 || octets.any { it !in 0..255 }) return false
    if (octets[0] == 10) return true
    if (octets[0] == 172 && octets[1] in 16..31) return true
    return octets[0] == 192 && octets[1] == 168
  }
}
