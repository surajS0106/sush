//! A Word document laid out as a PDF by a real layout engine, for an exact preview: Microsoft
//! Word on Windows (through its COM automation), else LibreOffice (`soffice --headless`), where
//! installed. HTML renderers only approximate Word's layout (floating shapes, tab stops, spacing),
//! which is why Claude's and ChatGPT's file previews go through LibreOffice too.
//!
//! Each conversion runs in a fresh temporary folder, with its own LibreOffice profile so it
//! doesn't collide with a LibreOffice the user has open, and is killed after a timeout.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How long a conversion may take, Word's start-up included.
const TIMEOUT: Duration = Duration::from_secs(90);

/// Why there's no PDF: no engine on this computer, or the one tried failed.
#[derive(Debug)]
pub enum RenderError {
    NoEngine,
    Failed(String),
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RenderError::NoEngine => f.write_str("Neither Microsoft Word nor LibreOffice is installed."),
            RenderError::Failed(e) => f.write_str(e),
        }
    }
}

/// The document as a PDF.
pub fn docx_to_pdf(docx: &[u8]) -> Result<Vec<u8>, RenderError> {
    let dir = TempDir::new().map_err(|e| RenderError::Failed(format!("Couldn't make a temporary folder: {e}")))?;
    let input = dir.0.join("document.docx");
    std::fs::write(&input, docx).map_err(|e| RenderError::Failed(format!("Couldn't write the document: {e}")))?;
    let mut failures = Vec::new();

    #[cfg(windows)]
    match word(&input, &dir.0.join("word.pdf")) {
        Ok(pdf) => return Ok(pdf),
        Err(Some(e)) => failures.push(format!("Word: {e}")),
        Err(None) => {}
    }
    if let Some(soffice) = find_soffice() {
        match libreoffice(&soffice, &input, &dir.0) {
            Ok(pdf) => return Ok(pdf),
            Err(e) => failures.push(format!("LibreOffice: {e}")),
        }
    }
    if failures.is_empty() {
        Err(RenderError::NoEngine)
    } else {
        Err(RenderError::Failed(failures.join(" ")))
    }
}

/// Word exports the document itself. `Err(None)` when Word isn't installed.
#[cfg(windows)]
fn word(input: &Path, output: &Path) -> Result<Vec<u8>, Option<String>> {
    // Paths go through the environment, so nothing in them is read as PowerShell. Word may hand
    // back the instance the user has open, so the script leaves it as it was: the document opens
    // hidden, alerts are restored, and Word quits only if it has no other documents and isn't
    // shown. A dummy password makes a protected document fail instead of prompting.
    const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
try { $word = New-Object -ComObject Word.Application } catch { [Console]::Error.Write('NO_WORD'); exit 3 }
$alerts = $word.DisplayAlerts
$m = [Type]::Missing
try {
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($env:SUSH_DOCX_IN, $false, $true, $false, 'sush-no-password', $m, $m, $m, $m, $m, $m, $false)
  try { $doc.ExportAsFixedFormat($env:SUSH_DOCX_OUT, 17) } finally { $doc.Close([ref]0) }
} finally {
  $word.DisplayAlerts = $alerts
  if ($word.Documents.Count -eq 0 -and -not $word.Visible) { $word.Quit([ref]0) }
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
"#;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
        .env("SUSH_DOCX_IN", input)
        .env("SUSH_DOCX_OUT", output);
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::workspace::shell::CREATE_NO_WINDOW);
    }
    let (ok, stderr) = run(cmd).map_err(Some)?;
    if !ok && stderr.contains("NO_WORD") {
        return Err(None);
    }
    match std::fs::read(output) {
        Ok(pdf) if ok && !pdf.is_empty() => Ok(pdf),
        _ => Err(Some(first_line(&stderr, "it didn't produce a PDF."))),
    }
}

fn libreoffice(soffice: &Path, input: &Path, dir: &Path) -> Result<Vec<u8>, String> {
    let profile = url::Url::from_directory_path(dir.join("profile")).map_err(|_| "Bad temporary folder.".to_string())?;
    let mut cmd = Command::new(soffice);
    cmd.arg(format!("-env:UserInstallation={profile}"))
        .args(["--headless", "--norestore", "--nolockcheck", "--convert-to", "pdf", "--outdir"])
        .arg(dir)
        .arg(input);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(crate::workspace::shell::CREATE_NO_WINDOW);
    }
    let (ok, stderr) = run(cmd)?;
    match std::fs::read(dir.join("document.pdf")) {
        Ok(pdf) if ok && !pdf.is_empty() => Ok(pdf),
        _ => Err(first_line(&stderr, "it didn't produce a PDF.")),
    }
}

/// LibreOffice's `soffice`, on the PATH or where its installers put it.
fn find_soffice() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for base in [std::env::var_os("ProgramFiles"), std::env::var_os("ProgramFiles(x86)")].into_iter().flatten() {
            candidates.push(Path::new(&base).join("LibreOffice").join("program").join("soffice.exe"));
        }
    } else if cfg!(target_os = "macos") {
        candidates.push("/Applications/LibreOffice.app/Contents/MacOS/soffice".into());
    } else {
        candidates.extend(["/usr/bin/soffice", "/usr/bin/libreoffice", "/usr/local/bin/soffice", "/snap/bin/libreoffice"].map(PathBuf::from));
    }
    let names: &[&str] = if cfg!(windows) { &["soffice.exe"] } else { &["soffice", "libreoffice"] };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            candidates.extend(names.iter().map(|n| dir.join(n)));
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Runs a command to the end or the timeout: whether it succeeded, and what it wrote to stderr.
fn run(mut cmd: Command) -> Result<(bool, String), String> {
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't start it: {e}"))?;
    let mut stderr = child.stderr.take();
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        if let Some(s) = stderr.as_mut() {
            use std::io::Read;
            let _ = s.take(64 * 1024).read_to_string(&mut out);
        }
        out
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() > TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("it took too long.".into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(e.to_string()),
        }
    };
    Ok((status.success(), reader.join().unwrap_or_default()))
}

fn first_line(stderr: &str, fallback: &str) -> String {
    stderr.lines().map(str::trim).find(|l| !l.is_empty()).map(str::to_string).unwrap_or_else(|| fallback.to_string())
}

/// A temporary folder, removed when dropped.
struct TempDir(PathBuf);

impl TempDir {
    fn new() -> std::io::Result<Self> {
        let mut bytes = [0u8; 8];
        getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
        let name: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        let dir = std::env::temp_dir().join(format!("sush-render-{name}"));
        std::fs::create_dir_all(&dir)?;
        Ok(TempDir(dir))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
