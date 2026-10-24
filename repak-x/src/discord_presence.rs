use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use log::info;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

const DISCORD_APP_ID: &str = "1563325728416604231"; // repakxtra: its own Discord app (name, icon and the repakxtra_logo art asset)

// repakxtra: the line under the app's name, and one logo for every accent (the asset key uploaded under Rich Presence >
// Art Assets of the app above)
const DETAILS: &str = "Modding with repakxtra";
const LOGO_ASSET: &str = "repakxtra_logo";

// repakxtra: one worker thread owns the Discord pipe. Every call queues a job and returns at once, so a Discord that
// stops answering (its reads have no timeout) stalls only the worker, never Settings, a command or exit. Jobs run in
// order, so connect, then the status, still happen in that order.
type Job = Box<dyn FnOnce(&mut Option<DiscordIpcClient>) + Send>;

pub struct DiscordPresenceManager {
    jobs: std::sync::mpsc::Sender<Job>,
    enabled: Arc<AtomicBool>,
    start_timestamp: i64,
    current_theme: Mutex<String>,
    current_state: Mutex<Option<String>>,
    current_details: Mutex<Option<String>>,
}

fn open(client: &mut Option<DiscordIpcClient>) -> Result<(), String> {
    if client.is_some() {
        return Ok(());
    }
    info!("Connecting to Discord...");
    let mut c = DiscordIpcClient::new(DISCORD_APP_ID);
    c.connect().map_err(|e| format!("Failed to connect to Discord: {e}"))?;
    info!("Connected to Discord Rich Presence");
    *client = Some(c);
    Ok(())
}

impl DiscordPresenceManager {
    pub fn new() -> Self {
        let start_timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let (jobs, inbox) = std::sync::mpsc::channel::<Job>();
        let _ = std::thread::Builder::new().name("discord-presence".into()).spawn(move || {
            let mut client: Option<DiscordIpcClient> = None;
            for job in inbox {
                job(&mut client);
            }
        });

        Self {
            jobs,
            enabled: Arc::new(AtomicBool::new(false)),
            start_timestamp,
            current_theme: Mutex::new("default".to_string()),
            current_state: Mutex::new(None),
            current_details: Mutex::new(None),
        }
    }

    fn queue(&self, job: impl FnOnce(&mut Option<DiscordIpcClient>) + Send + 'static) {
        let _ = self.jobs.send(Box::new(job));
    }

    /// Set the color theme for the Discord logo
    /// This will be applied immediately if connected
    pub fn set_theme(&self, theme: &str) {
        *self.current_theme.lock() = theme.to_string();
        info!("Discord theme set to: {}", theme);

        let state_opt = { self.current_state.lock().clone() };
        let details_opt = { self.current_details.lock().clone() };

        if let Some(state) = state_opt {
            let _ = self.set_activity(&state, details_opt.as_deref());
        }
    }

    /// Get the current theme
    pub fn get_theme(&self) -> String {
        self.current_theme.lock().clone()
    }

    /// Connects on the worker (a handshake Discord can hold up for tens of seconds). A failure is logged there.
    pub fn connect(&self) -> Result<(), String> {
        self.enabled.store(true, Ordering::SeqCst);
        let enabled = self.enabled.clone();
        self.queue(move |client| {
            if enabled.load(Ordering::SeqCst) {
                if let Err(e) = open(client) {
                    log::warn!("[Discord] {e}");
                }
            }
        });
        Ok(())
    }

    pub fn disconnect(&self) -> Result<(), String> {
        self.enabled.store(false, Ordering::SeqCst);
        *self.current_state.lock() = None;
        *self.current_details.lock() = None;
        self.queue(|client| {
            if let Some(mut c) = client.take() {
                info!("Disconnecting from Discord...");
                let _ = c.clear_activity();
                let _ = c.close();
            }
        });
        Ok(())
    }

    pub fn is_connected(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub fn set_activity(&self, state: &str, details: Option<&str>) -> Result<(), String> {
        // Saved for theme updates, and sent on the worker
        *self.current_state.lock() = Some(state.to_string());
        *self.current_details.lock() = details.map(|s| s.to_string());
        let (state, details, start) = (state.to_string(), details.map(str::to_string), self.start_timestamp);
        let enabled = self.enabled.clone();
        self.queue(move |client| {
            if !enabled.load(Ordering::SeqCst) {
                return;
            }
            // self-heal: a connection dropped or never made is opened again first
            if let Err(e) = open(client) {
                log::warn!("[Discord] {e}");
                return;
            }
            let Some(c) = client.as_mut() else { return };
            let mut activity_builder = activity::Activity::new()
                .state(&state)
                .timestamps(activity::Timestamps::new().start(start))
                .assets(activity::Assets::new().large_image(LOGO_ASSET).large_text("repakxtra, a Marvel Rivals mod manager"));
            if let Some(d) = details.as_deref() {
                activity_builder = activity_builder.details(d);
            }
            // read Discord's reply too: unread replies pile up in the pipe until Discord drops the connection
            if let Err(e) = c.set_activity(activity_builder).and_then(|_| c.recv().map(|_| ())) {
                *client = None; // reopened on the next update
                log::warn!("[Discord] Failed to set activity: {e}");
            }
        });
        Ok(())
    }

    pub fn set_idle(&self) -> Result<(), String> {
        self.set_activity("Idle", Some(DETAILS))
    }

    pub fn set_managing_mods(&self, mod_count: usize) -> Result<(), String> {
        let state = format!(
            "Managing {} mod{}",
            mod_count,
            if mod_count == 1 { "" } else { "s" }
        );
        self.set_activity(&state, Some(DETAILS))
    }

    pub fn set_installing_mod(&self) -> Result<(), String> {
        self.set_activity("Installing mods", Some(DETAILS))
    }

    pub fn set_sharing_mods(&self) -> Result<(), String> {
        self.set_activity("Sharing mods", Some(DETAILS))
    }

    pub fn set_receiving_mods(&self) -> Result<(), String> {
        self.set_activity("Receiving mods", Some(DETAILS))
    }

    pub fn clear_activity(&self) -> Result<(), String> {
        self.queue(|client| {
            if let Some(c) = client.as_mut() {
                let _ = c.clear_activity().and_then(|_| c.recv().map(|_| ()));
            }
        });
        Ok(())
    }
}

impl Default for DiscordPresenceManager {
    fn default() -> Self {
        Self::new()
    }
}

pub type SharedDiscordPresence = Arc<DiscordPresenceManager>;

pub fn create_discord_manager() -> SharedDiscordPresence {
    Arc::new(DiscordPresenceManager::new())
}
