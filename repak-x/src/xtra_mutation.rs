//! Ordinary mod changes may overlap as before; a snapshot, a restore, or a storage cleanup reserves them all until it finishes.
use std::sync::Arc;
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

#[cfg(not(test))]
fn gate() -> Arc<RwLock<()>> {
    static GATE: std::sync::OnceLock<Arc<RwLock<()>>> = std::sync::OnceLock::new();
    GATE.get_or_init(|| Arc::new(RwLock::new(()))).clone()
}

// Tests run in parallel, each on its own thread: one gate per thread, so a test's mod change never blocks another's encryption
#[cfg(test)]
fn gate() -> Arc<RwLock<()>> {
    thread_local!(static GATE: Arc<RwLock<()>> = Arc::new(RwLock::new(())));
    GATE.with(Arc::clone)
}

pub fn edit() -> Result<OwnedRwLockReadGuard<()>, String> {
    gate().try_read_owned().map_err(|_| "A snapshot or a storage cleanup is running. Wait for it to finish before changing mods.".into())
}

/// Every other mod change waits while `what` (a snapshot, a restore, a storage cleanup) runs, and it waits for them.
pub fn alone(what: &str) -> Result<OwnedRwLockWriteGuard<()>, String> {
    gate().try_write_owned().map_err(|_| format!("A mod change is still running. Try {what} again when it is done."))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encryption_excludes_mutations_in_both_directions() {
        let g = Arc::new(RwLock::new(()));
        let edit = g.clone().try_read_owned().unwrap();
        assert!(g.clone().try_write_owned().is_err());
        drop(edit);
        let encryption = g.clone().try_write_owned().unwrap();
        assert!(g.clone().try_read_owned().is_err());
        drop(encryption);
        assert!(g.try_read_owned().is_ok());
    }
}
