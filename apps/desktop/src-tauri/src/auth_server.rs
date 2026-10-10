// The bundled auth server (apps/server compiled with `bun build --compile`).
//
// Release builds ship it as a sidecar next to the app executable and run it on
// AUTH_PORT, with its database in the app data dir. Dev builds don't start it;
// run `bun run dev:server` instead.

use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Must match VITE_AUTH_URL in the root `build` script and connect-src in tauri.release.conf.json.
const AUTH_PORT: u16 = 47321;

/// Baked in by build.rs from BETTER_AUTH_SECRET (env or the repo's .env).
const AUTH_SECRET: &str = env!("SUSH_AUTH_SECRET");

#[derive(Default)]
pub struct AuthServer(Mutex<Option<Child>>);

impl AuthServer {
    /// Starts the server and waits briefly for it to accept connections, so the
    /// UI's first session check doesn't race it.
    pub fn start(&self, data_dir: &Path, log_dir: &Path) -> std::io::Result<()> {
        std::fs::create_dir_all(data_dir)?;
        std::fs::create_dir_all(log_dir)?;
        let log = std::fs::File::create(log_dir.join("auth-server.log"))?;
        let exe = std::env::current_exe()?.with_file_name(format!("sush-auth{}", std::env::consts::EXE_SUFFIX));

        let mut cmd = Command::new(exe);
        cmd.env("PORT", AUTH_PORT.to_string())
            .env("BETTER_AUTH_URL", format!("http://localhost:{AUTH_PORT}"))
            .env("BETTER_AUTH_SECRET", AUTH_SECRET)
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
        *self.0.lock().unwrap() = Some(cmd.spawn()?);

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
        if let Some(mut child) = self.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
