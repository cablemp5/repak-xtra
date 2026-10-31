//! Ordinary mod changes may overlap as before; encryption reserves them all until publication finishes.
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
    gate().try_read_owned().map_err(|_| "Encryption is running. Wait for it to finish before changing mods.".into())
}

pub fn encrypt() -> Result<OwnedRwLockWriteGuard<()>, String> {
    gate().try_write_owned().map_err(|_| "Another mod change is still running. Wait for it to finish before encrypting.".into())
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
