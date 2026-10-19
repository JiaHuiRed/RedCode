package ai.redcode.mobile

import java.security.MessageDigest
import java.util.Locale

object CertificatePins {
  fun normalize(value: String): String? {
    val pin = value.filterNot { it == ':' || it.isWhitespace() }.lowercase(Locale.ROOT)
    return pin.takeIf { it.matches(Regex("[0-9a-f]{64}")) }
  }

  fun matches(expected: String, certificateDer: ByteArray): Boolean {
    val pin = normalize(expected) ?: return false
    val actual = sha256(certificateDer)
    return MessageDigest.isEqual(pin.toByteArray(Charsets.US_ASCII), actual.toByteArray(Charsets.US_ASCII))
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
}
