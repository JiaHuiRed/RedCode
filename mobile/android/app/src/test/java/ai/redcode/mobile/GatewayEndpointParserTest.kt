package ai.redcode.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.Test

class GatewayEndpointParserTest {
  @Test
  fun acceptsOnlyHttpsLoopbackAndPrivateIpv4Endpoints() {
    assertNotNull(GatewayEndpointParser.parse("https://localhost:4312"))
    assertNotNull(GatewayEndpointParser.parse("https://192.168.1.20:4312/"))
    assertNotNull(GatewayEndpointParser.parse("https://10.0.0.8:4312"))
    assertNull(GatewayEndpointParser.parse("http://127.0.0.1:4312"))
    assertNull(GatewayEndpointParser.parse("https://8.8.8.8:4312"))
    assertNull(GatewayEndpointParser.parse("https://redcode.example:4312"))
    assertNull(GatewayEndpointParser.parse("https://192.168.1.20"))
    assertNull(GatewayEndpointParser.parse("https://user@192.168.1.20:4312"))
    assertNull(GatewayEndpointParser.parse("https://192.168.1.20:4312/other"))
  }

  @Test
  fun createsTheSameUnpaddedBase64UrlSessionPathAsTheWebApp() {
    val endpoint = GatewayEndpointParser.parse("https://localhost:4312")!!
    val sessionUrl = GatewayEndpointParser.sessionUrl(endpoint, "C:\\work\\專案", "ses_123")

    assertEquals("https://localhost:4312/Qzpcd29ya1zlsIjmoYg/session/ses_123", sessionUrl)
    assertNull(GatewayEndpointParser.sessionUrl(endpoint, "C:\\work", "invalid/id"))
  }
}
