//! Built-in speech-to-text: whisper.cpp running in-process with the
//! `base.en` model, downloaded on first use into the app data directory.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::Engine;
use futures::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};
use tokio::io::AsyncWriteExt;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

const MODEL_FILE: &str = "ggml-base.en.bin";
const MODEL_URL: &str = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const MODEL_SIZE: u64 = 147_964_211;
const MODEL_SHA256: &str = "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002";

#[derive(Default)]
pub struct Whisper {
    /// Loaded once, then shared; loading takes a second or two.
    ctx: Mutex<Option<Arc<WhisperContext>>>,
    /// Held while downloading so concurrent requests wait for one download.
    download: tokio::sync::Mutex<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WhisperModelStatus {
    downloaded: bool,
    size_bytes: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    received: u64,
    total: u64,
}

fn model_path(app: &AppHandle) -> AppResult<PathBuf> {
    let dir = app.path().app_data_dir().map_err(|e| AppError::Invalid(e.to_string()))?.join("models");
    Ok(dir.join(MODEL_FILE))
}

#[tauri::command]
pub fn whisper_model_status(app: AppHandle) -> AppResult<WhisperModelStatus> {
    Ok(WhisperModelStatus { downloaded: model_path(&app)?.is_file(), size_bytes: MODEL_SIZE })
}

/// Download the model if it isn't already there. Verified against a pinned
/// SHA-256 before it's moved into place, so a partial or tampered file is never used.
#[tauri::command]
pub async fn whisper_model_download(
    app: AppHandle,
    whisper: State<'_, Whisper>,
    state: State<'_, AppState>,
    on_progress: Channel<DownloadProgress>,
) -> AppResult<()> {
    let _guard = whisper.download.lock().await;
    let path = model_path(&app)?;
    if path.is_file() {
        return Ok(());
    }
    std::fs::create_dir_all(path.parent().unwrap())?;
    let part = path.with_extension("bin.part");

    let resp = state.http.get(MODEL_URL).send().await.map_err(|e| AppError::Invalid(format!("model download: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::Invalid(format!("model download: HTTP {}", resp.status())));
    }
    let mut file = tokio::fs::File::create(&part).await?;
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| AppError::Invalid(format!("model download: {e}")))?;
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        let _ = on_progress.send(DownloadProgress { received, total: MODEL_SIZE });
    }
    file.flush().await?;
    drop(file);

    let digest = format!("{:x}", hasher.finalize());
    if received != MODEL_SIZE || digest != MODEL_SHA256 {
        let _ = std::fs::remove_file(&part);
        return Err(AppError::Invalid("The speech model download was corrupted. Try again.".into()));
    }
    std::fs::rename(&part, &path)?;
    Ok(())
}

/// Transcribe a 16 kHz mono 16-bit WAV clip with the built-in model.
#[tauri::command]
pub async fn transcribe_local(app: AppHandle, whisper: State<'_, Whisper>, audio_base64_wav: String) -> AppResult<String> {
    let path = model_path(&app)?;
    if !path.is_file() {
        return Err(AppError::Invalid("The built-in speech model isn't downloaded yet.".into()));
    }
    let wav = base64::engine::general_purpose::STANDARD
        .decode(audio_base64_wav)
        .map_err(|e| AppError::Invalid(format!("audio is not valid base64: {e}")))?;
    let samples = pcm16_samples(&wav)?;

    let cached = whisper.ctx.lock().unwrap().clone();
    let ctx = match cached {
        Some(ctx) => ctx,
        None => {
            let ctx = tauri::async_runtime::spawn_blocking(move || {
                whisper_rs::install_logging_hooks(); // keep whisper.cpp's chatter off stdout
                WhisperContext::new_with_params(&path, WhisperContextParameters::default()).map(Arc::new)
            })
            .await
            .map_err(|e| AppError::Invalid(e.to_string()))?
            .map_err(|e| AppError::Invalid(format!("couldn't load the speech model: {e}")))?;
            *whisper.ctx.lock().unwrap() = Some(ctx.clone());
            ctx
        }
    };

    tauri::async_runtime::spawn_blocking(move || run(&ctx, &samples))
        .await
        .map_err(|e| AppError::Invalid(e.to_string()))?
}

fn run(ctx: &WhisperContext, samples: &[f32]) -> AppResult<String> {
    let err = |e: whisper_rs::WhisperError| AppError::Invalid(format!("transcription failed: {e}"));
    let mut state = ctx.create_state().map_err(err)?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    // Scales with every logical core (measured on a Ryzen 3700X), so use them all.
    let threads = std::thread::available_parallelism().map_or(4, |n| n.get());
    params.set_n_threads(threads as i32);
    params.set_language(Some("en"));
    params.set_no_context(true);
    params.set_no_timestamps(true);
    params.set_suppress_blank(true);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    state.full(params, samples).map_err(err)?;

    let text = state
        .as_iter()
        .filter_map(|seg| seg.to_str_lossy().ok().map(|s| s.trim().to_string()))
        // Whisper labels silence and noise as "[BLANK_AUDIO]", "(music)" and the like.
        .filter(|s| !s.is_empty() && !is_annotation(s))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(text)
}

fn is_annotation(s: &str) -> bool {
    (s.starts_with('[') && s.ends_with(']')) || (s.starts_with('(') && s.ends_with(')'))
}

/// Samples from a mono 16-bit PCM WAV, scaled to [-1, 1].
fn pcm16_samples(wav: &[u8]) -> AppResult<Vec<f32>> {
    let bad = || AppError::Invalid("audio is not a 16-bit PCM WAV".into());
    if wav.len() < 12 || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return Err(bad());
    }
    let mut i = 12;
    while i + 8 <= wav.len() {
        let id = &wav[i..i + 4];
        let len = u32::from_le_bytes(wav[i + 4..i + 8].try_into().unwrap()) as usize;
        let body = &wav[i + 8..(i + 8 + len).min(wav.len())];
        if id == b"data" {
            return Ok(body.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect());
        }
        i += 8 + len + (len & 1);
    }
    Err(bad())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wav(samples: &[i16]) -> Vec<u8> {
        let data: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        let mut out = b"RIFF".to_vec();
        out.extend((36 + data.len() as u32).to_le_bytes());
        out.extend(b"WAVEfmt ");
        out.extend(16u32.to_le_bytes());
        out.extend([1, 0, 1, 0]);
        out.extend(16000u32.to_le_bytes());
        out.extend(32000u32.to_le_bytes());
        out.extend([2, 0, 16, 0]);
        out.extend(b"data");
        out.extend((data.len() as u32).to_le_bytes());
        out.extend(data);
        out
    }

    #[test]
    fn reads_pcm16_samples() {
        let s = pcm16_samples(&wav(&[0, 16384, -32768])).unwrap();
        assert_eq!(s, vec![0.0, 0.5, -1.0]);
    }

    #[test]
    fn rejects_non_wav() {
        assert!(pcm16_samples(b"not a wav file").is_err());
    }

    /// Real inference. Run with WHISPER_MODEL=<ggml-base.en.bin> WHISPER_WAV=<16 kHz mono wav>
    /// `cargo test -p sush whisper -- --ignored`.
    #[test]
    #[ignore]
    fn transcribes_real_audio() {
        let model = std::env::var("WHISPER_MODEL").expect("WHISPER_MODEL");
        let samples = pcm16_samples(&std::fs::read(std::env::var("WHISPER_WAV").expect("WHISPER_WAV")).unwrap()).unwrap();
        let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default()).unwrap();
        let start = std::time::Instant::now();
        let text = run(&ctx, &samples).unwrap();
        println!("{:.1}s audio in {:?}: {text}", samples.len() as f32 / 16000.0, start.elapsed());
        assert!(!text.is_empty());
    }

    #[test]
    fn spots_whisper_annotations() {
        assert!(is_annotation("[BLANK_AUDIO]"));
        assert!(is_annotation("(music)"));
        assert!(!is_annotation("Hello there."));
    }
}
