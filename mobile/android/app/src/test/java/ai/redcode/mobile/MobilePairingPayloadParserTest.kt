package ai.redcode.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class MobilePairingPayloadParserTest {
  private val fingerprint = "ab".repeat(32)

  @Test
  fun parsesAValidDesktopPairingQr() {
    val payload = """
      {"type":"redcode-mobile-pairing","version":1,"url":"https://192.168.1.20:4312","code":"01234567","fingerprint":"$fingerprint"}
    """.trimIndent()

    assertEquals(
      MobilePairingPayload("https://192.168.1.20:4312", fingerprint, "01234567"),
      MobilePairingPayloadParser.parse(payload),
    )
  }

  @Test
  fun rejectsMalformedOrUnsafePairingQrs() {
    val template = """{"type":"redcode-mobile-pairing","version":1,"url":"%s","code":"%s","fingerprint":"%s"}"""

    assertNull(MobilePairingPayloadParser.parse("not json"))
    assertNull(MobilePairingPayloadParser.parse(template.format("http://192.168.1.20:4312", "01234567", fingerprint)))
    assertNull(MobilePairingPayloadParser.parse(template.format("https://8.8.8.8:4312", "01234567", fingerprint)))
    assertNull(MobilePairingPayloadParser.parse(template.format("https://192.168.1.20:4312", "bad", fingerprint)))
    assertNull(MobilePairingPayloadParser.parse(template.format("https://192.168.1.20:4312", "01234567", "bad")))
    assertNull(MobilePairingPayloadParser.parse(" ".repeat(2049)))
  }
}
