package ai.redcode.mobile

import android.content.Context
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

class MobileWebViewClient(
  context: Context,
  private val gateway: PairedGateway,
  private val onUnauthorized: () -> Unit,
) : WebViewClient() {
  private val endpoint = GatewayEndpointParser.parse(gateway.baseUrl)
    ?: throw IllegalArgumentException("Saved Gateway address is invalid.")
  private val assetLoader = WebViewAssetLoader.Builder()
    .setDomain(endpoint.host)
    .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(context))
    .build()
  private val projectPathPrefix = GatewayEndpointParser.sessionUrl(endpoint, gateway.directory, gateway.sessionID)
    ?.let { Uri.parse(it).encodedPath?.substringBefore("/session") }
    ?: throw IllegalArgumentException("Saved workspace route is invalid.")

  override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
    if (!sameOrigin(request.url)) return blockedResponse()
    if (request.method != "GET") return null
    if (request.isForMainFrame && isAppRoute(request.url.encodedPath.orEmpty())) {
      return indexResponse(context = view.context)
    }
    return assetLoader.shouldInterceptRequest(request.url)
  }

  override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
    return !sameOrigin(request.url)
  }

  override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: SslError) {
    if (isPinnedGatewayError(error)) {
      handler.proceed()
      return
    }
    handler.cancel()
  }

  override fun onReceivedHttpError(
    view: WebView,
    request: WebResourceRequest,
    response: WebResourceResponse,
  ) {
    if (sameOrigin(request.url) && response.statusCode == 401) onUnauthorized()
  }

  private fun isPinnedGatewayError(error: SslError): Boolean {
    if (error.primaryError != SslError.SSL_UNTRUSTED) return false
    if (error.hasError(SslError.SSL_IDMISMATCH) ||
      error.hasError(SslError.SSL_DATE_INVALID) ||
      error.hasError(SslError.SSL_EXPIRED) ||
      error.hasError(SslError.SSL_NOTYETVALID) ||
      error.hasError(SslError.SSL_INVALID)
    ) {
      return false
    }
    val url = Uri.parse(error.url)
    if (!sameOrigin(url)) return false
    val der = SslCertificate.saveState(error.certificate).getByteArray("x509-certificate") ?: return false
    return CertificatePins.matches(gateway.fingerprint, der)
  }

  private fun isAppRoute(path: String): Boolean {
    return path == projectPathPrefix || path.startsWith("$projectPathPrefix/")
  }

  private fun sameOrigin(uri: Uri): Boolean {
    return uri.scheme == "https" &&
      uri.host?.equals(endpoint.host, ignoreCase = true) == true &&
      uri.port == endpoint.port
  }

  private fun indexResponse(context: Context): WebResourceResponse {
    return WebResourceResponse(
      "text/html",
      "UTF-8",
      context.assets.open("index.html"),
    )
  }

  private fun blockedResponse(): WebResourceResponse {
    return WebResourceResponse(
      "text/plain",
      "UTF-8",
      403,
      "Blocked",
      emptyMap(),
      ByteArrayInputStream(byteArrayOf()),
    )
  }
}
