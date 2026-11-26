package com.sush.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The key that encrypts the secrets file (`secrets.rs`). It's random, and kept only wrapped
 * by an AES key in the Android Keystore, which never leaves the Keystore (or its secure hardware,
 * where the phone has it). Rust gets it unwrapped at startup ([unlock]) and holds it in memory.
 */
object Vault {
  private const val ALIAS = "sush-secrets"
  private const val PREFS = "vault"
  private const val WRAPPED = "wrapped-key"

  /** Hand Rust the key, making one the first time. Call before anything reads a secret. */
  fun unlock(context: Context) {
    try {
      SushNative.unlock(dataKey(context))
    } catch (e: Exception) {
      // Rust then says the keys are locked rather than send a request without one.
      Log.e("Sush", "couldn't unlock the secrets", e)
    }
  }

  private fun dataKey(context: Context): ByteArray {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val wrapper = wrapperKey()
    prefs.getString(WRAPPED, null)?.let { stored ->
      try {
        val blob = Base64.decode(stored, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrapper, GCMParameterSpec(128, blob, 0, 12))
        return cipher.doFinal(blob, 12, blob.size - 12)
      } catch (e: Exception) {
        // The Keystore's key changed: the old keys can't be read, so start again with a new one.
        Log.w("Sush", "couldn't unwrap the secrets' key; starting a new one", e)
      }
    }
    val key = ByteArray(32).also { SecureRandom().nextBytes(it) }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrapper)
    prefs.edit().putString(WRAPPED, Base64.encodeToString(cipher.iv + cipher.doFinal(key), Base64.NO_WRAP)).commit()
    return key
  }

  private fun wrapperKey(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .build()
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply { init(spec) }.generateKey()
  }
}
