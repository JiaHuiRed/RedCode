package ai.redcode.mobile

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.URL
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

data class PairedGateway(
  val baseUrl: String,
  val fingerprint: String,
  val token: String,
  val directory: String,
  val sessionID: String,
)

object GatewayApi {
  private const val PAIR_RESPONSE_LIMIT = 16 * 1024

  fun pair(url: String, fingerprint: String, code: String, deviceName: String): PairedGateway {
    val endpoint =
      GatewayEndpointParser.parse(url)
        ?: throw IllegalArgumentException("Use an HTTPS localhost or private IPv4 address with an explicit port.")
    val pin =
      CertificatePins.normalize(fingerprint)
        ?: throw IllegalArgumentException("Enter the complete 64-character SHA-256 certificate fingerprint.")
    if (!code.matches(Regex("[0-9]{8}"))) throw IllegalArgumentException("The pairing code must contain 8 digits.")

    val ssl = SSLContext.getInstance("TLS").apply {
      init(null, arrayOf(PinnedTrustManager(pin)), SecureRandom())
    }
    val connection = URL("${endpoint.baseUrl}/__mobile/pair").openConnection() as HttpsURLConnection
    try {
      connection.sslSocketFactory = ssl.socketFactory
      connection.hostnameVerifier = HttpsURLConnection.getDefaultHostnameVerifier()
      connection.connectTimeout = 5_000
      connection.readTimeout = 5_000
      connection.instanceFollowRedirects = false
      connection.useCaches = false
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.setRequestProperty("Accept", "application/json")
      connection.setRequestProperty("Content-Type", "application/json")

      val body = JSONObject()
        .put("code", code)
        .put("name", deviceName.take(64))
        .toString()
        .toByteArray(Charsets.UTF_8)
      connection.setFixedLengthStreamingMode(body.size)
      connection.outputStream.use { it.write(body) }

      val status = connection.responseCode
      val response = readLimited(if (status in 200..299) connection.inputStream else connection.errorStream)
        .toString(Charsets.UTF_8)
      if (status !in 200..299) {
        val message = runCatching { JSONObject(response).optString("error") }.getOrNull()
        throw IllegalStateException(message?.takeIf { it.isNotBlank() } ?: "Pairing failed with HTTP $status.")
      }

      val result = JSONObject(response)
      val token = result.optString("token")
      val directory = result.optString("directory")
      val sessionID = result.optString("sessionID")
      if (!token.matches(Regex("[A-Za-z0-9_-]{32,64}"))) throw IllegalStateException("Gateway returned an invalid device token.")
      if (directory.isBlank() || directory.toByteArray(Charsets.UTF_8).size > 8192) {
        throw IllegalStateException("Gateway returned an invalid workspace scope.")
      }
      if (!sessionID.matches(Regex("ses_[A-Za-z0-9_-]{1,128}"))) {
        throw IllegalStateException("Gateway did not return an active session.")
      }
      return PairedGateway(endpoint.baseUrl, pin, token, directory, sessionID)
    } finally {
      connection.disconnect()
    }
  }

  private fun readLimited(stream: InputStream?): ByteArray {
    if (stream == null) return byteArrayOf()
    stream.use { input ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(2048)
      while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        if (output.size() + count > PAIR_RESPONSE_LIMIT) {
          throw IllegalStateException("Gateway response exceeded the mobile limit.")
        }
        output.write(buffer, 0, count)
      }
      return output.toByteArray()
    }
  }

  private class PinnedTrustManager(private val fingerprint: String) : X509TrustManager {
    override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) {
      throw CertificateException("Client certificates are not accepted.")
    }

    override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
      val certificate = chain.firstOrNull() ?: throw CertificateException("Gateway certificate is missing.")
      certificate.checkValidity()
      if (!CertificatePins.matches(fingerprint, certificate.encoded)) {
        throw CertificateException("Gateway certificate fingerprint does not match.")
      }
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
  }
}
