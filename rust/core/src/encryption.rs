//! Account password encryption, byte-compatible with the Node build.
//!
//! This has to reproduce `src/main/services/encryption.js` exactly: AES-256-CBC
//! with PKCS#7, keys derived with Node's `crypto.scryptSync` defaults
//! (N=16384, r=8, p=1) and the same salt/label strings. If any of that drifts,
//! every password already on disk becomes unreadable — so the format is pinned
//! by cross-runtime tests (see tests/node_compat.rs).
//!
//! Three key generations exist in the wild:
//!   v3 — scrypt(`{MachineGuid}|{user}|lostleague-v3`, "salt-v3")   (current)
//!   v2 — scrypt(`{wmic csproduct uuid}|{user}|lostleague-v2`, "salt-v2")
//!   legacy — scrypt("lost-league-manager-secret", "salt"), no machine binding
//! Only v3 is ever written; v2 and legacy exist to read old files.

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use once_cell::sync::OnceCell;
use rand::RngCore;

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

const KEY_LEN: usize = 32;

/// Node's `crypto.scryptSync(password, salt, 32)` defaults: N=2^14, r=8, p=1.
fn scrypt_key(password: &str, salt: &str) -> [u8; KEY_LEN] {
    let params = scrypt::Params::new(14, 8, 1, KEY_LEN).expect("valid scrypt params");
    let mut out = [0u8; KEY_LEN];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out)
        .expect("scrypt derivation cannot fail with valid params");
    out
}

fn legacy_key() -> &'static [u8; KEY_LEN] {
    static KEY: OnceCell<[u8; KEY_LEN]> = OnceCell::new();
    KEY.get_or_init(|| scrypt_key("lost-league-manager-secret", "salt"))
}

fn export_key() -> &'static [u8; KEY_LEN] {
    static KEY: OnceCell<[u8; KEY_LEN]> = OnceCell::new();
    KEY.get_or_init(|| scrypt_key("lost-league-export-v1", "export-salt-ll"))
}

fn current_user() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".to_string())
}

/// A stable per-install identifier that doesn't depend on wmic.exe, which
/// recent Windows 11 builds removed outright.
#[cfg(windows)]
fn read_machine_guid() -> anyhow::Result<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let out = std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .output()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let guid = text
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let name = parts.next()?;
            let kind = parts.next()?;
            if name.eq_ignore_ascii_case("MachineGuid") && kind.eq_ignore_ascii_case("REG_SZ") {
                parts.next().map(|v| v.trim().to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| anyhow::anyhow!("MachineGuid not found in registry output"))?;
    Ok(guid)
}

#[cfg(not(windows))]
fn read_machine_guid() -> anyhow::Result<String> {
    anyhow::bail!("MachineGuid is Windows-only")
}

fn machine_key() -> &'static [u8; KEY_LEN] {
    static KEY: OnceCell<[u8; KEY_LEN]> = OnceCell::new();
    KEY.get_or_init(|| match read_machine_guid() {
        Ok(guid) => scrypt_key(
            &format!("{guid}|{}|lostleague-v3", current_user()),
            "salt-v3",
        ),
        Err(e) => {
            tracing::warn!("Could not read MachineGuid ({e}) — using fallback key");
            *legacy_key()
        }
    })
}

/// The pre-v3 key, derived from `wmic csproduct get uuid`. Only ever used to
/// *read* old passwords; returns None when wmic is gone, so callers can tell
/// "no key available" apart from "the fallback key".
#[cfg(windows)]
fn legacy_wmic_key() -> Option<&'static [u8; KEY_LEN]> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    static KEY: OnceCell<Option<[u8; KEY_LEN]>> = OnceCell::new();
    KEY.get_or_init(|| {
        let out = std::process::Command::new("wmic")
            .args(["csproduct", "get", "uuid", "/value"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let uuid = text
            .lines()
            .find_map(|l| l.trim().strip_prefix("UUID=").map(|v| v.trim().to_string()))
            .map(|v| v.replace(['{', '}'], ""))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        Some(scrypt_key(
            &format!("{uuid}|{}|lostleague-v2", current_user()),
            "salt-v2",
        ))
    })
    .as_ref()
}

#[cfg(not(windows))]
fn legacy_wmic_key() -> Option<&'static [u8; KEY_LEN]> {
    None
}

fn encrypt_with(key: &[u8; KEY_LEN], plaintext: &str) -> String {
    let mut iv = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut iv);
    let ct = Aes256CbcEnc::new(key.into(), &iv.into())
        .encrypt_padded_vec_mut::<Pkcs7>(plaintext.as_bytes());
    format!("{}:{}", hex::encode(iv), hex::encode(ct))
}

fn decrypt_with(key: &[u8; KEY_LEN], body: &str) -> Option<String> {
    let (iv_hex, ct_hex) = body.split_once(':')?;
    let iv = hex::decode(iv_hex).ok()?;
    let ct = hex::decode(ct_hex.replace(':', "")).ok()?;
    if iv.len() != 16 {
        return None;
    }
    let iv: [u8; 16] = iv.try_into().ok()?;
    let plain = Aes256CbcDec::new(key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(&ct)
        .ok()?;
    String::from_utf8(plain).ok()
}

/// Encrypts a password for storage. Always writes the current (v3) format.
pub fn encrypt(plaintext: &str) -> String {
    format!("v3:{}", encrypt_with(machine_key(), plaintext))
}

/// Reads any generation of stored password. Returns None when none of the
/// candidate keys work — for a v2 blob on a machine where wmic is gone that is
/// genuinely unrecoverable and the user has to re-enter the password.
pub fn decrypt(stored: &str) -> Option<String> {
    if stored.is_empty() {
        return None;
    }
    if let Some(body) = stored.strip_prefix("v3:") {
        return decrypt_with(machine_key(), body).or_else(|| decrypt_with(legacy_key(), body));
    }
    if let Some(body) = stored.strip_prefix("v2:") {
        return legacy_wmic_key()
            .and_then(|k| decrypt_with(k, body))
            .or_else(|| decrypt_with(machine_key(), body))
            .or_else(|| decrypt_with(legacy_key(), body));
    }
    decrypt_with(legacy_key(), stored)
}

/// Pre-v2 blobs, used only by the one-time migration on startup.
pub fn decrypt_legacy(stored: &str) -> Option<String> {
    decrypt_with(legacy_key(), stored)
}

pub fn encrypt_export<T: serde::Serialize>(value: &T) -> anyhow::Result<String> {
    let json = serde_json::to_string(value)?;
    Ok(format!("llem:{}", encrypt_with(export_key(), &json)))
}

pub fn decrypt_export<T: serde::de::DeserializeOwned>(text: &str) -> Option<T> {
    let body = text.strip_prefix("llem:")?;
    let json = decrypt_with(export_key(), body)?;
    serde_json::from_str(&json).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_password() {
        let secret = "hunter2-with-ümlauts-and-:colons:";
        let stored = encrypt(secret);
        assert!(stored.starts_with("v3:"));
        assert_eq!(decrypt(&stored).as_deref(), Some(secret));
    }

    #[test]
    fn each_encryption_uses_a_fresh_iv() {
        let a = encrypt("same");
        let b = encrypt("same");
        assert_ne!(a, b, "a reused IV would leak that two accounts share a password");
        assert_eq!(decrypt(&a), decrypt(&b));
    }

    #[test]
    fn garbage_decrypts_to_none_instead_of_panicking() {
        assert_eq!(decrypt("v3:nothex:alsonothex"), None);
        assert_eq!(decrypt("v3:"), None);
        assert_eq!(decrypt(""), None);
        assert_eq!(decrypt("v3:00112233445566778899aabbccddeeff:00"), None);
    }

    #[test]
    fn legacy_key_matches_the_known_node_derivation() {
        // scryptSync('lost-league-manager-secret', 'salt', 32) — pinned so a
        // dependency bump that changed scrypt defaults would fail loudly here
        // rather than silently orphaning every stored password.
        assert_eq!(
            hex::encode(legacy_key()),
            "567f7e48173f6a8948acd3cd74b399423b485dfdafd7c0fd6750429b904cf72c"
        );
        // scryptSync('lost-league-export-v1', 'export-salt-ll', 32)
        assert_eq!(
            hex::encode(export_key()),
            "9f7238399386e29323aa305947c56f126e252d08b7af58b40739a3c13c36e3e9"
        );
    }

    #[test]
    fn export_blobs_round_trip() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Payload {
            accounts: Vec<String>,
        }
        let value = Payload { accounts: vec!["a".into(), "b".into()] };
        let blob = encrypt_export(&value).unwrap();
        assert!(blob.starts_with("llem:"));
        assert_eq!(decrypt_export::<Payload>(&blob), Some(value));
    }

    #[test]
    fn export_rejects_a_blob_without_its_marker() {
        assert_eq!(decrypt_export::<serde_json::Value>("nope:abc"), None);
    }
}
