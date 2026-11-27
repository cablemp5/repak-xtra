//! Ordinary mod changes may overlap as before; a snapshot, a restore, or a storage cleanup reserves them all until it finishes.
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
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

/// How many mod changes (either kind) have started, and how many run now: read by `era`, so no lock is taken for it.
struct Counts {
    started: AtomicU64,
    running: AtomicUsize,
}
#[cfg(not(test))]
fn counts<R>(f: impl FnOnce(&Counts) -> R) -> R {
    static C: Counts = Counts { started: AtomicU64::new(0), running: AtomicUsize::new(0) };
    f(&C)
}
#[cfg(test)]
fn counts<R>(f: impl FnOnce(&Counts) -> R) -> R {
    thread_local!(static C: Counts = const { Counts { started: AtomicU64::new(0), running: AtomicUsize::new(0) } });
    C.with(f)
}

/// A mod change in progress: holds the gate and counts as running until dropped.
pub struct Held<G>(#[allow(dead_code)] G);
impl<G> Drop for Held<G> {
    fn drop(&mut self) {
        counts(|c| c.running.fetch_sub(1, SeqCst));
    }
}
fn held<G>(g: G) -> Held<G> {
    // running first, then started: `era` reads started first, so a change it misses as running it sees as started
    counts(|c| {
        c.running.fetch_add(1, SeqCst);
        c.started.fetch_add(1, SeqCst);
    });
    Held(g)
}

pub fn edit() -> Result<Held<OwnedRwLockReadGuard<()>>, String> {
    gate().try_read_owned().map(held).map_err(|_| "A backup or a storage cleanup is running. Wait for it to finish before changing mods.".into())
}

/// Every other mod change waits while `what` (a snapshot, a restore, a storage cleanup) runs, and it waits for them.
pub fn alone(what: &str) -> Result<Held<OwnedRwLockWriteGuard<()>>, String> {
    gate().try_write_owned().map(held).map_err(|_| format!("A mod change is still running. Try {what} again when it is done."))
}

/// None while any mod change runs, else a number that changes whenever one starts: equal before and after a folder
/// walk, no mod change (a toggle, an update, a restore) ran during it, so the walk saw no half-done one (xtra_respace.rs).
pub fn era() -> Option<u64> {
    counts(|c| {
        let started = c.started.load(SeqCst);
        (c.running.load(SeqCst) == 0).then_some(started)
    })
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

    #[test]
    fn era_is_none_during_any_change_and_moves_on_after() {
        let before = era().unwrap();
        let restore = alone("a restore").unwrap();
        assert_eq!(era(), None);
        drop(restore);
        let after_restore = era().unwrap();
        assert!(after_restore > before, "a walk that spanned the restore must not match");
        let toggle = edit().unwrap();
        assert_eq!(era(), None, "an ordinary change (a VFX update, a toggle) counts too");
        drop(toggle);
        assert!(era().unwrap() > after_restore);
    }
}
