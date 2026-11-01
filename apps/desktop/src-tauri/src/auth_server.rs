// The bundled auth server (apps/server compiled with `bun build --compile`).
//
// Release builds ship it as a sidecar next to the app executable and run it on
// AUTH_PORT, with its database in the app data dir. Dev builds don't start it;
// run `bun run dev:server` instead.
//
// It is also the relay for shared sessions. By default only this machine
// reaches it; the user can let others on the same network in (Settings →
// Sharing), which restarts it listening on every interface and is remembered
// for the next launch.

use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Must match VITE_AUTH_URL in the root `build` script and connect-src in tauri.release.conf.json.
pub const AUTH_PORT: u16 = 47321;

/// Present in the app data dir while the server is open to the local network.
const LAN_FLAG: &str = "relay-lan";

/// The server's signing secret, generated on first launch and kept in the app
/// data dir. Each install has its own, so no secret ships inside the binary.
fn secret(data_dir: &Path) -> std::io::Result<String> {
    use std::io::Write;
    let path = data_dir.join("auth-secret");
    match std::fs::read_to_string(&path) {
        Ok(secret) if secret.trim().len() >= 32 => return Ok(secret.trim().to_owned()),
        Ok(_) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e),
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
    let secret: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(&path)?.write_all(secret.as_bytes())?;
    Ok(secret)
}

/// Where the server keeps its data and logs, and where the browser viewer's files are.
#[derive(Clone)]
pub struct Dirs {
    pub data: PathBuf,
    pub log: PathBuf,
    /// The bundled browser viewer (`apps/viewer/dist`), served at invite links' own address.
    pub viewer: Option<PathBuf>,
}

#[derive(Default)]
pub struct AuthServer {
    child: Mutex<Option<Child>>,
    dirs: Mutex<Option<Dirs>>,
}

impl AuthServer {
    /// Starts the server and waits briefly for it to accept connections, so the
    /// UI's first session check doesn't race it.
    pub fn start(&self, dirs: Dirs) -> std::io::Result<()> {
        let Dirs { data: data_dir, log: log_dir, viewer } = &dirs;
        std::fs::create_dir_all(data_dir)?;
        std::fs::create_dir_all(log_dir)?;
        let log = std::fs::File::create(log_dir.join("auth-server.log"))?;
        let exe = std::env::current_exe()?.with_file_name(format!("sush-auth{}", std::env::consts::EXE_SUFFIX));
        let lan = data_dir.join(LAN_FLAG).exists();

        let mut cmd = Command::new(exe);
        if lan {
            cmd.env("SUSH_RELAY_LAN", "1");
        }
        if let Some(viewer) = viewer.as_ref().filter(|v| v.join("index.html").exists()) {
            cmd.env("SUSH_VIEWER_DIR", viewer);
        }
        cmd.env("PORT", AUTH_PORT.to_string())
            .env("BETTER_AUTH_URL", format!("http://localhost:{AUTH_PORT}"))
            .env("BETTER_AUTH_SECRET", secret(data_dir)?)
            .env("DATABASE_PATH", data_dir.join("auth.sqlite"))
            .env("NODE_ENV", "production")
            .env("SUSH_PARENT_PID", std::process::id().to_string())
            .stdin(Stdio::null())
            .stdout(log.try_clone()?)
            .stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        *self.child.lock().unwrap() = Some(cmd.spawn()?);
        *self.dirs.lock().unwrap() = Some(dirs.clone());

        let addr = SocketAddr::from(([127, 0, 0, 1], AUTH_PORT));
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if TcpStream::connect_timeout(&addr, Duration::from_millis(100)).is_ok() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Ok(())
    }

    pub fn stop(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    /// Whether others on the local network can reach it.
    pub fn lan(&self) -> bool {
        self.dirs.lock().unwrap().as_ref().is_some_and(|d| d.data.join(LAN_FLAG).exists())
    }

    /// Open it to the local network, or back to this machine only: remembered,
    /// then the server restarts. Signed-in sessions carry on (they're in its
    /// database); live shares reconnect by themselves.
    pub fn set_lan(&self, on: bool) -> std::io::Result<()> {
        let dirs = self.dirs.lock().unwrap().clone().ok_or_else(|| std::io::Error::other("The server isn't running."))?;
        let flag = dirs.data.join(LAN_FLAG);
        if on {
            std::fs::write(&flag, "")?;
        } else if flag.exists() {
            std::fs::remove_file(&flag)?;
        }
        self.stop();
        // Its port is free again once the old process is gone.
        std::thread::sleep(Duration::from_millis(200));
        self.start(dirs)
    }
}
