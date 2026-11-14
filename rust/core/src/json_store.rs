use std::fs;
use std::path::Path;

use serde::de::DeserializeOwned;
use serde::Serialize;

/// Shared read/write-with-atomic-rename primitive for the app's small JSON data
/// files (accounts, config, rank history, honor watch, build paths).
///
/// `save` returns the error so callers for whom a write failure is critical
/// (accounts, config) can surface it, while callers riding along on someone
/// else's operation (rank history, honor watch) can swallow it — a disk hiccup
/// on a side channel must never break the thing it's attached to.
pub fn load<T: DeserializeOwned>(path: &Path, label: &str) -> Option<T> {
    if !path.exists() {
        return None;
    }
    match fs::read_to_string(path) {
        Ok(raw) => match serde_json::from_str::<T>(&raw) {
            Ok(value) => Some(value),
            Err(e) => {
                tracing::error!("Failed to parse {label}: {e}");
                None
            }
        },
        Err(e) => {
            tracing::error!("Failed to read {label}: {e}");
            None
        }
    }
}

pub fn load_or_default<T: DeserializeOwned + Default>(path: &Path, label: &str) -> T {
    load(path, label).unwrap_or_default()
}

/// Writes to `<path>.tmp` and renames over the target, so a crash or a full disk
/// mid-write leaves the previous file intact rather than a truncated one.
pub fn save<T: Serialize>(path: &Path, value: &T, label: &str) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}tmp",
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default()
    ));
    // Four-space indentation matches what the Node build wrote, so switching
    // runtimes doesn't rewrite every file into a different shape.
    let text = serde_json::to_string_pretty(value)?;
    let text = reindent_to_four_spaces(&text);
    fs::write(&tmp, text).map_err(|e| {
        tracing::error!("Failed to save {label}: {e}");
        e
    })?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// serde_json pretty-prints with two spaces; JSON.stringify(v, null, 4) used
/// four. Purely cosmetic, but it keeps diffs of these files quiet.
fn reindent_to_four_spaces(text: &str) -> String {
    text.lines()
        .map(|line| {
            let indent = line.len() - line.trim_start().len();
            format!("{}{}", " ".repeat(indent * 2), line.trim_start())
        })
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Serialize, Deserialize, PartialEq, Debug, Default)]
    struct Sample {
        name: String,
        count: u32,
    }

    #[test]
    fn round_trips_through_disk() {
        let dir = std::env::temp_dir().join(format!("llm-json-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.json");

        let value = Sample { name: "Ahri".into(), count: 3 };
        save(&file, &value, "sample").unwrap();
        let read: Sample = load(&file, "sample").unwrap();
        assert_eq!(read, value);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_is_none_not_an_error() {
        let missing = std::env::temp_dir().join("llm-does-not-exist-xyz.json");
        assert!(load::<Sample>(&missing, "sample").is_none());
    }

    #[test]
    fn corrupt_file_falls_back_to_default() {
        let dir = std::env::temp_dir().join(format!("llm-json-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bad.json");
        std::fs::write(&file, "{ not json at all").unwrap();

        let value: Sample = load_or_default(&file, "sample");
        assert_eq!(value, Sample::default());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn writes_four_space_indentation_like_the_node_build() {
        let dir = std::env::temp_dir().join(format!("llm-json-fmt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("fmt.json");

        save(&file, &Sample { name: "x".into(), count: 1 }, "sample").unwrap();
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\n    \"name\""), "got: {raw}");

        std::fs::remove_dir_all(&dir).ok();
    }
}
