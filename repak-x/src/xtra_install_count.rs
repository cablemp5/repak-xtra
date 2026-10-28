//! Successful quick-install files count as one mod only after the complete bundle landed.
use std::{collections::{HashMap, HashSet}, path::Path};
use crate::xtra_bundle::companion;

#[derive(Default)]
pub struct InstallTally(HashMap<String, (HashSet<String>, HashSet<String>)>);

impl InstallTally {
    pub fn copied(&mut self, source: &Path, destination: &Path) {
        let ext = source.extension().and_then(|s| s.to_str()).unwrap_or_default().to_ascii_lowercase();
        let ios = ext == "utoc" || ext == "ucas" || companion(source, "utoc").exists() || companion(source, "ucas").exists();
        let key = companion(destination, "pak").to_string_lossy().to_lowercase();
        let (required, copied) = self.0.entry(key).or_default();
        required.extend(if ios { vec!["pak", "utoc", "ucas"] } else { vec!["pak"] }.into_iter().map(str::to_string));
        copied.insert(if ext == "bak_repak" || ext == "pak_disabled" { "pak".into() } else { ext });
    }

    pub fn count(&self) -> usize {
        self.0.values().filter(|(required, copied)| required.is_subset(copied)).count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn counts_bundles_not_companions_or_partial_failures() {
        let d = tempfile::tempdir().unwrap();
        for f in ["A.pak", "A.utoc", "A.ucas", "B.pak", "B.utoc", "B.ucas", "Plain.pak"] { fs::write(d.path().join(f), b"x").unwrap(); }
        let mut tally = InstallTally::default();
        let mut copy = |name: &str| { let p = d.path().join(name); tally.copied(&p, &p); };
        for f in ["A.pak", "A.utoc", "A.ucas", "A.pak", "B.pak", "B.utoc", "Plain.pak"] { copy(f); }
        assert_eq!(tally.count(), 2, "A and Plain succeeded; B's failed UCAS adds nothing");
        tally.copied(&d.path().join("B.ucas"), &d.path().join("B.ucas"));
        assert_eq!(tally.count(), 3);
    }
}
