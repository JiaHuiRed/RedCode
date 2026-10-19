package ai.redcode.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class TokenStore(context: Context) {
  private val preferences = context.getSharedPreferences("paired-gateway", Context.MODE_PRIVATE)

  fun load(): PairedGateway? {
    val stored = preferences.getString(STORAGE_KEY, null) ?: return null
    val encrypted = Base64.decode(stored, Base64.NO_WRAP)
    if (encrypted.size <= IV_BYTES) throw IllegalStateException("Saved pairing is incomplete.")
    val iv = encrypted.copyOfRange(0, IV_BYTES)
    val ciphertext = encrypted.copyOfRange(IV_BYTES, encrypted.size)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, iv))
    val payload = JSONObject(cipher.doFinal(ciphertext).toString(Charsets.UTF_8))
    val config = PairedGateway(
      baseUrl = payload.getString("baseUrl"),
      fingerprint = payload.getString("fingerprint"),
      token = payload.getString("token"),
      directory = payload.getString("directory"),
      sessionID = payload.getString("sessionID"),
    )
    if (GatewayEndpointParser.parse(config.baseUrl) == null ||
      CertificatePins.normalize(config.fingerprint) == null ||
      !config.token.matches(Regex("[A-Za-z0-9_-]{32,64}")) ||
      config.directory.isBlank() ||
      config.directory.toByteArray(Charsets.UTF_8).size > 8192 ||
      !config.sessionID.matches(Regex("ses_[A-Za-z0-9_-]{1,128}"))
    ) {
      throw IllegalStateException("Saved pairing is invalid.")
    }
    return config
  }

  fun save(config: PairedGateway) {
    val payload = JSONObject()
      .put("baseUrl", config.baseUrl)
      .put("fingerprint", config.fingerprint)
      .put("token", config.token)
      .put("directory", config.directory)
      .put("sessionID", config.sessionID)
      .toString()
      .toByteArray(Charsets.UTF_8)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val encrypted = cipher.iv + cipher.doFinal(payload)
    val saved = preferences.edit()
      .putString(STORAGE_KEY, Base64.encodeToString(encrypted, Base64.NO_WRAP))
      .commit()
    if (!saved) throw IllegalStateException("Could not save the encrypted pairing.")
  }

  fun clear() {
    if (!preferences.edit().remove(STORAGE_KEY).commit()) {
      throw IllegalStateException("Could not clear the saved pairing.")
    }
    val store = KeyStore.getInstance(ANDROID_KEYSTORE)
    store.load(null)
    if (store.containsAlias(KEY_ALIAS)) store.deleteEntry(KEY_ALIAS)
  }

  private fun key(): SecretKey {
    val store = KeyStore.getInstance(ANDROID_KEYSTORE)
    store.load(null)
    (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setRandomizedEncryptionRequired(true)
        .build(),
    )
    return generator.generateKey()
  }

  private companion object {
    const val ANDROID_KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "ai.redcode.mobile.gateway"
    const val STORAGE_KEY = "encrypted-pairing"
    const val IV_BYTES = 12
    const val TAG_BITS = 128
  }
}
