//! repakxtra: launch_game sets launch_record to "0" and a background thread puts the old value back once the game
//! starts (up to 30 s). Only one restore is pending at a time: a second launch keeps the first launch's old value
//! (the file already says "0" by then), and a Skip Launcher toggle cancels the restore so it is not undone.

use std::sync::{Mutex, MutexGuard};

/// Held from reading launch_record to writing it (launch, restore, toggle), so none of them interleave.
pub fn file_lock() -> MutexGuard<'static, ()> {
    static FILE: Mutex<()> = Mutex::new(());
    FILE.lock().unwrap_or_else(|e| e.into_inner())
}

static PENDING: Mutex<Option<(u64, Option<String>)>> = Mutex::new(None);
static NEXT: Mutex<u64> = Mutex::new(0);

/// Starts a launch with the value read from launch_record now: returns this launch's id.
pub fn begin(read_now: Option<String>) -> u64 {
    let id = {
        let mut n = NEXT.lock().unwrap();
        *n += 1;
        *n
    };
    let mut p = PENDING.lock().unwrap();
    let original = p.take().map_or(read_now, |(_, kept)| kept);
    *p = Some((id, original));
    id
}

/// The value to restore for launch `id`, or None when a later launch or a toggle took over.
pub fn finish(id: u64) -> Option<String> {
    let mut p = PENDING.lock().unwrap();
    match p.as_ref() {
        Some((pending, _)) if *pending == id => p.take().and_then(|(_, v)| v),
        _ => None,
    }
}

/// A manual Skip Launcher toggle: no pending restore may overwrite it.
pub fn cancel() {
    *PENDING.lock().unwrap() = None;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_toggle_or_second_launch_takes_over_the_restore() {
        let a = begin(Some("6".into()));
        let b = begin(Some("0".into())); // the file says "0" because of launch a
        assert_eq!(finish(a), None, "launch a's restore was taken over");
        assert_eq!(finish(b), Some("6".into()), "launch b restores the value from before launch a");
        let c = begin(Some("6".into()));
        cancel();
        assert_eq!(finish(c), None, "a toggle cancels the restore");
    }
}
