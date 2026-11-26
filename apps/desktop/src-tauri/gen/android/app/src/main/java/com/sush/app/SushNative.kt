package com.sush.app

/** Calls into Rust (`src/android.rs`). */
object SushNative {
  init {
    System.loadLibrary("sush_lib")
  }

  /** The key for the secrets file ([Vault]). */
  external fun unlock(key: ByteArray)
}
