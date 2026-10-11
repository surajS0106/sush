use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, RwLock};

use sush_core::mcp::{McpClient, ServerSpec};
use sush_core::memory::MemoryDir;
use sush_core::store::Store;
use sush_core::workspace::sandbox::Sandbox;
use sush_core::ProviderConfig;
use tokio_util::sync::CancellationToken;

use crate::error::AppResult;

pub struct AppState {
    providers_path: PathBuf,
    pub providers: RwLock<Vec<ProviderConfig>>,
    /// Conversations and attachments (`sush.db`, `blobs/` in the app data dir).
    pub store: std::sync::Arc<Store>,
    /// Agent runs in flight, by thread.
    pub runs: crate::runs::Runs,
    /// Long-term memory files (`memory/` in the app data dir).
    pub memory: std::sync::Arc<MemoryDir>,
    /// OS sandbox for Cowork shell commands (`sandbox/` in the app data dir).
    pub sandbox: std::sync::Arc<Sandbox>,
    /// Interactive terminals the user opened in Cowork, by id.
    pub terminals: Mutex<HashMap<String, crate::terminal::Terminal>>,
    /// In-flight chat streams by id, so the UI can cancel them.
    pub streams: Mutex<HashMap<String, CancellationToken>>,
    pub http: reqwest::Client,
    /// Running connectors by id, with the server they were started for.
    pub connectors: tokio::sync::Mutex<HashMap<String, (ServerSpec, std::sync::Arc<McpClient>)>>,
    /// Browser sign-ins in progress by connector id, so a new attempt or Cancel can stop one.
    pub authorizing: Mutex<HashMap<String, CancellationToken>>,
}

impl AppState {
    pub fn load(config_dir: PathBuf, data_dir: PathBuf) -> AppResult<Self> {
        std::fs::create_dir_all(&config_dir)?;
        let providers_path = config_dir.join("providers.json");
        let providers = match std::fs::read_to_string(&providers_path) {
            Ok(s) => serde_json::from_str(&s)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            providers_path,
            providers: RwLock::new(providers),
            store: std::sync::Arc::new(Store::open(&data_dir)?),
            runs: Default::default(),
            memory: std::sync::Arc::new(MemoryDir::open(&data_dir.join("memory"))?),
            sandbox: std::sync::Arc::new(Sandbox::new(data_dir.join("sandbox"))),
            terminals: Default::default(),
            streams: Mutex::new(HashMap::new()),
            connectors: Default::default(),
            authorizing: Default::default(),
            http: reqwest::Client::builder().user_agent(concat!("Sush/", env!("CARGO_PKG_VERSION"))).build()
                .map_err(sush_core::ProviderError::from)?,
        })
    }

    pub fn provider(&self, id: &str) -> Option<ProviderConfig> {
        self.providers.read().unwrap().iter().find(|p| p.id == id).cloned()
    }

    /// Write providers to disk via a temp file so a crash can't truncate the config.
    pub fn persist(&self) -> AppResult<()> {
        let json = serde_json::to_string_pretty(&*self.providers.read().unwrap())?;
        let tmp = self.providers_path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(tmp, &self.providers_path)?;
        Ok(())
    }
}
