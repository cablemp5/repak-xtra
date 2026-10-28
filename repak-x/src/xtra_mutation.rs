//! Ordinary mod changes may overlap as before; encryption reserves them all until publication finishes.
use std::sync::{Arc, OnceLock};
use tokio::sync::{OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};

fn gate() -> Arc<RwLock<()>> {
    static GATE: OnceLock<Arc<RwLock<()>>> = OnceLock::new();
    GATE.get_or_init(|| Arc::new(RwLock::new(()))).clone()
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
