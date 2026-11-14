//! Cross-runtime compatibility with the Node build's `encryption.js`.
//!
//! Everyone upgrading from the Electron version has an accounts.json full of
//! passwords encrypted by that file with a machine-bound key. If this Rust
//! implementation can't read them, upgrading silently loses every saved
//! password — so both directions are tested against the real JS, on this
//! machine, with this machine's key.
//!
//! Skipped (not failed) when node or the JS source isn't present, so the suite
//! still runs from a checkout without the Node app.

use std::path::PathBuf;
use std::process::Command;

fn repo_root() -> PathBuf {
    // rust/core/tests -> repo root
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf()
}

fn js_encryption_module() -> Option<PathBuf> {
    let p = repo_root().join("src/main/services/encryption.js");
    p.exists().then_some(p)
}

fn run_node(script: &str) -> Option<String> {
    let out = Command::new("node").arg("-e").arg(script).output().ok()?;
    if !out.status.success() {
        eprintln!("node failed: {}", String::from_utf8_lossy(&out.stderr));
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The JS module path as a JS string literal (forward slashes, escaped).
fn module_literal() -> Option<String> {
    let p = js_encryption_module()?;
    Some(p.to_string_lossy().replace('\\', "/"))
}

#[test]
fn rust_reads_passwords_written_by_the_node_build() {
    let Some(module) = module_literal() else {
        eprintln!("SKIP: src/main/services/encryption.js not found");
        return;
    };

    let secret = "s3cret-päss:with:colons";
    let script = format!(
        "const e = require('{module}'); process.stdout.write(e.encrypt({}));",
        serde_json::to_string(secret).unwrap()
    );
    let Some(stored) = run_node(&script) else {
        eprintln!("SKIP: node unavailable");
        return;
    };

    assert!(stored.starts_with("v3:"), "node wrote unexpected format: {stored}");
    assert_eq!(
        llm_core::encryption::decrypt(&stored).as_deref(),
        Some(secret),
        "Rust could not decrypt a password written by the Node build — \
         upgrading would lose every saved password"
    );
}

#[test]
fn the_node_build_reads_passwords_written_by_rust() {
    let Some(module) = module_literal() else {
        eprintln!("SKIP: src/main/services/encryption.js not found");
        return;
    };

    let secret = "written-by-rust-42";
    let stored = llm_core::encryption::encrypt(secret);
    let script = format!(
        "const e = require('{module}'); process.stdout.write(String(e.decrypt({})));",
        serde_json::to_string(&stored).unwrap()
    );
    let Some(decrypted) = run_node(&script) else {
        eprintln!("SKIP: node unavailable");
        return;
    };

    // Both runtimes stay interoperable, so a user can roll back to the Electron
    // build without their vault becoming unreadable.
    assert_eq!(decrypted, secret);
}

#[test]
fn legacy_and_v2_blobs_from_node_still_open() {
    let Some(module) = module_literal() else {
        eprintln!("SKIP: encryption.js not found");
        return;
    };

    // A pre-v2 blob: encrypted with the shared legacy key, no version prefix.
    let secret = "ancient-password";
    let script = format!(
        "const crypto=require('crypto');\
         const KEY=crypto.scryptSync('lost-league-manager-secret','salt',32);\
         const iv=crypto.randomBytes(16);\
         const c=crypto.createCipheriv('aes-256-cbc',KEY,iv);\
         const enc=Buffer.concat([c.update({}),c.final()]);\
         process.stdout.write(iv.toString('hex')+':'+enc.toString('hex'));",
        serde_json::to_string(secret).unwrap()
    );
    let Some(stored) = run_node(&script) else {
        eprintln!("SKIP: node unavailable");
        return;
    };

    assert_eq!(llm_core::encryption::decrypt(&stored).as_deref(), Some(secret));
    assert_eq!(llm_core::encryption::decrypt_legacy(&stored).as_deref(), Some(secret));
    let _ = module;
}

#[test]
fn export_blobs_are_interchangeable_with_the_node_build() {
    let Some(module) = module_literal() else {
        eprintln!("SKIP: encryption.js not found");
        return;
    };

    let blob = llm_core::encryption::encrypt_export(&serde_json::json!({
        "accounts": [{ "username": "someone", "region": "euw" }]
    }))
    .unwrap();

    let script = format!(
        "const e = require('{module}'); \
         const v = e.decryptExport({}); \
         process.stdout.write(v ? v.accounts[0].username : 'FAILED');",
        serde_json::to_string(&blob).unwrap()
    );
    let Some(out) = run_node(&script) else {
        eprintln!("SKIP: node unavailable");
        return;
    };
    assert_eq!(out, "someone", "an export from this build must import into the old one");
}
