package ai.redcode.mobile

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.google.zxing.integration.android.IntentIntegrator
import java.util.concurrent.Executors

class MainActivity : Activity() {
  private val worker = Executors.newSingleThreadExecutor()
  private lateinit var tokenStore: TokenStore
  private var paired: PairedGateway? = null
  private var webView: WebView? = null
  private var pairingStatus: TextView? = null
  private var pairingButton: Button? = null
  private var scanPairingButton: Button? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= 30) window.setDecorFitsSystemWindows(true)
    tokenStore = TokenStore(this)
    CookieManager.getInstance().setAcceptCookie(true)

    val stored = try {
      tokenStore.load()
    } catch (error: Exception) {
      val clearError = runCatching { tokenStore.clear() }.exceptionOrNull()
      showPairing(message = clearError?.message ?: error.message ?: getString(R.string.mobile_error))
      return
    }
    if (stored == null) showPairing() else openGateway(stored)
  }

  override fun onResume() {
    super.onResume()
    webView?.onResume()
  }

  override fun onPause() {
    webView?.onPause()
    super.onPause()
  }

  @Suppress("DEPRECATION")
  override fun onBackPressed() {
    val current = webView
    if (current?.canGoBack() == true) {
      current.goBack()
      return
    }
    super.onBackPressed()
  }

  override fun onDestroy() {
    webView?.stopLoading()
    webView?.destroy()
    webView = null
    CookieManager.getInstance().removeAllCookies(null)
    CookieManager.getInstance().flush()
    worker.shutdownNow()
    super.onDestroy()
  }

  private fun showPairing(
    initialUrl: String = "",
    initialFingerprint: String = "",
    message: String? = null,
  ) {
    paired = null
    CookieManager.getInstance().removeAllCookies(null)
    CookieManager.getInstance().flush()
    webView?.stopLoading()
    webView?.destroy()
    webView = null

    val content = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(24), dp(32), dp(24), dp(24))
      setBackgroundColor(Color.rgb(247, 247, 247))
    }
    val title = text(getString(R.string.mobile_pair_title), 25f, Color.rgb(24, 24, 24)).apply {
      typeface = Typeface.DEFAULT_BOLD
    }
    content.addView(title, matchWrap())
    content.addView(
      text(getString(R.string.mobile_pair_description), 14f, Color.rgb(86, 86, 86)).apply {
        setPadding(0, dp(10), 0, dp(16))
      },
      matchWrap(),
    )

    val scanButton = Button(this).apply {
      text = getString(R.string.mobile_scan_qr)
      setOnClickListener {
        IntentIntegrator(this@MainActivity).apply {
          setPrompt(getString(R.string.mobile_scan_prompt))
          setBeepEnabled(false)
          setBarcodeImageEnabled(false)
          setOrientationLocked(false)
          initiateScan()
        }
      }
    }
    scanPairingButton = scanButton
    content.addView(scanButton, LinearLayout.LayoutParams(matchWrap().width, dp(52)))

    val (urlLabel, urlInput) = inputField(
      getString(R.string.mobile_gateway_address),
      getString(R.string.mobile_gateway_address_hint),
      InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
      initialUrl,
    )
    val (codeLabel, codeInput) = inputField(
      getString(R.string.mobile_pairing_code),
      getString(R.string.mobile_pairing_code_hint),
      InputType.TYPE_CLASS_NUMBER,
      "",
    )
    val (fingerprintLabel, fingerprintInput) = inputField(
      getString(R.string.mobile_certificate_fingerprint),
      getString(R.string.mobile_fingerprint_hint),
      InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
      initialFingerprint,
    )

    val status = text(message.orEmpty(), 13f, Color.rgb(156, 22, 22)).apply {
      visibility = if (message.isNullOrBlank()) View.GONE else View.VISIBLE
      setPadding(0, dp(12), 0, dp(4))
    }
    pairingStatus = status
    content.addView(status, matchWrap())

    val manualFields = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      visibility = View.GONE
    }
    val manualToggle = Button(this).apply {
      text = getString(R.string.mobile_manual_pairing)
      setOnClickListener {
        val showManualFields = manualFields.visibility != View.VISIBLE
        manualFields.visibility = if (showManualFields) View.VISIBLE else View.GONE
        text = getString(
          if (showManualFields) R.string.mobile_hide_manual_pairing else R.string.mobile_manual_pairing,
        )
      }
    }
    content.addView(manualToggle, matchWrap())
    listOf(urlLabel, urlInput, codeLabel, codeInput, fingerprintLabel, fingerprintInput).forEach {
      manualFields.addView(it, matchWrap())
    }

    val pairButton = Button(this).apply {
      text = getString(R.string.mobile_pair)
      setOnClickListener {
        pairGateway(urlInput.text.toString(), fingerprintInput.text.toString(), codeInput.text.toString())
      }
    }
    pairingButton = pairButton
    manualFields.addView(pairButton, LinearLayout.LayoutParams(matchWrap().width, dp(52)).apply {
      topMargin = dp(16)
    })
    content.addView(manualFields, matchWrap())

    val scroll = ScrollView(this).apply {
      isFillViewport = true
      addView(content)
    }
    setContentView(scroll)
  }

  @Suppress("DEPRECATION")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
    if (result == null) {
      super.onActivityResult(requestCode, resultCode, data)
      return
    }
    val contents = result.contents ?: return
    val payload = MobilePairingPayloadParser.parse(contents)
    if (payload == null) {
      pairingStatus?.apply {
        text = getString(R.string.mobile_invalid_pairing_qr)
        visibility = View.VISIBLE
      }
      return
    }
    pairGateway(payload.url, payload.fingerprint, payload.code)
  }

  private fun pairGateway(url: String, fingerprint: String, code: String) {
    val status = pairingStatus ?: return
    pairingButton?.isEnabled = false
    scanPairingButton?.isEnabled = false
    status.text = getString(R.string.mobile_pairing)
    status.visibility = View.VISIBLE
    worker.execute {
      try {
        val result = GatewayApi.pair(url, fingerprint, code, Build.MODEL)
        tokenStore.save(result)
        runOnUiThread {
          if (!isFinishing && !isDestroyed) openGateway(result)
        }
      } catch (error: Exception) {
        runOnUiThread {
          if (isFinishing || isDestroyed) return@runOnUiThread
          status.text = error.message ?: getString(R.string.mobile_error)
          status.visibility = View.VISIBLE
          pairingButton?.isEnabled = true
          scanPairingButton?.isEnabled = true
        }
      }
    }
  }

  private fun openGateway(config: PairedGateway) {
    val endpoint = GatewayEndpointParser.parse(config.baseUrl)
    val sessionUrl = endpoint?.let { GatewayEndpointParser.sessionUrl(it, config.directory, config.sessionID) }
    if (endpoint == null || sessionUrl == null) {
      showPairing(config.baseUrl, config.fingerprint, "Saved pairing is invalid.")
      return
    }
    paired = config

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(Color.WHITE)
    }
    val toolbar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setPadding(dp(16), dp(2), dp(8), dp(2))
      setBackgroundColor(Color.rgb(247, 247, 247))
    }
    toolbar.addView(
      text(getString(R.string.app_name), 16f, Color.rgb(24, 24, 24)).apply {
        typeface = Typeface.DEFAULT_BOLD
      },
      LinearLayout.LayoutParams(0, dp(52), 1f).apply { gravity = Gravity.CENTER_VERTICAL },
    )
    toolbar.addView(Button(this).apply {
      text = getString(R.string.mobile_forget)
      setOnClickListener { clearSavedPairing(config) }
    })
    root.addView(toolbar, matchWrap())

    val browser = WebView(this).apply {
      setBackgroundColor(Color.WHITE)
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
      settings.setSupportMultipleWindows(false)
      settings.setSupportZoom(false)
      settings.builtInZoomControls = false
      settings.displayZoomControls = false
      settings.javaScriptCanOpenWindowsAutomatically = false
      settings.userAgentString = "${settings.userAgentString} RedCodeMobileCompanion/1"
      webViewClient = MobileWebViewClient(this@MainActivity, config) {
        onGatewayUnauthorized(config)
      }
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false)
    root.addView(browser, LinearLayout.LayoutParams(
      LinearLayout.LayoutParams.MATCH_PARENT,
      0,
      1f,
    ))
    webView = browser
    setContentView(root)

    CookieManager.getInstance().setCookie(
      config.baseUrl,
      "rc_device=${config.token}; Path=/; Secure; HttpOnly; SameSite=Strict",
    ) {
      if (!it || paired != config || isFinishing || isDestroyed) return@setCookie
      browser.loadUrl(sessionUrl)
    }
  }

  private fun onGatewayUnauthorized(config: PairedGateway) {
    runOnUiThread {
      if (paired != config) return@runOnUiThread
      CookieManager.getInstance().removeAllCookies(null)
      CookieManager.getInstance().flush()
      val clearError = runCatching { tokenStore.clear() }.exceptionOrNull()
      showPairing(
        config.baseUrl,
        config.fingerprint,
        clearError?.message ?: getString(R.string.mobile_desktop_revoked),
      )
    }
  }

  private fun clearSavedPairing(config: PairedGateway) {
    CookieManager.getInstance().removeAllCookies {
      CookieManager.getInstance().flush()
      try {
        tokenStore.clear()
        showPairing(config.baseUrl, config.fingerprint)
      } catch (error: Exception) {
        showPairing(
          config.baseUrl,
          config.fingerprint,
          error.message ?: getString(R.string.mobile_error),
        )
      }
    }
  }

  private fun inputField(
    title: String,
    hint: String,
    inputType: Int,
    value: String,
  ): Pair<TextView, EditText> {
    val label = text(title, 13f, Color.rgb(58, 58, 58)).apply {
      setPadding(0, dp(10), 0, dp(4))
    }
    val input = EditText(this).apply {
      this.hint = hint
      this.inputType = inputType
      setSingleLine(true)
      setText(value)
      setPadding(dp(12), dp(8), dp(12), dp(8))
      textSize = 14f
      setBackgroundColor(Color.WHITE)
    }
    return label to input
  }

  private fun text(value: String, size: Float, color: Int) = TextView(this).apply {
    text = value
    textSize = size
    setTextColor(color)
  }

  private fun matchWrap() = LinearLayout.LayoutParams(
    LinearLayout.LayoutParams.MATCH_PARENT,
    LinearLayout.LayoutParams.WRAP_CONTENT,
  )

  private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
