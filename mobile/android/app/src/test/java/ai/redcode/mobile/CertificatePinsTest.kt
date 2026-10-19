package ai.redcode.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CertificatePinsTest {
  @Test
  fun matchesTheExactSha256CertificateFingerprint() {
    val certificate = "test".toByteArray()
    val fingerprint = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"

    assertTrue(CertificatePins.matches(fingerprint, certificate))
    assertFalse(CertificatePins.matches("0".repeat(64), certificate))
    assertFalse(CertificatePins.matches("not-a-fingerprint", certificate))
  }

  @Test
  fun normalizesSeparatorsAndCaseWithoutWeakeningLength() {
    val fingerprint = "9F:86:D0:81:88:4C:7D:65:9A:2F:EA:A0:C5:5A:D0:15:A3:BF:4F:1B:2B:0B:82:2C:D1:5D:6C:15:B0:F0:0A:08"

    assertEquals("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", CertificatePins.normalize(fingerprint))
    assertEquals(null, CertificatePins.normalize("0".repeat(63)))
  }
}
