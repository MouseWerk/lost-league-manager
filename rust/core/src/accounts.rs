//! Stored League accounts.
//!
//! The on-disk shape is the Node build's accounts.json, unchanged: an array of
//! records whose `password` is a versioned ciphertext (see `encryption`).
//! Plaintext passwords never leave this module except through
//! [`reveal_password`], which the shell gates behind the vault.

use serde::{Deserialize, Serialize};

use crate::{encryption, json_store, paths};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub username: String,
    /// Versioned ciphertext, never plaintext.
    pub password: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub riot_id: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub appear_offline: bool,
    #[serde(default)]
    pub auto_skin_random: bool,
    #[serde(default)]
    pub auto_champ_lock: String,
    /// Unknown fields from other versions ride along instead of being dropped
    /// on the next save.
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// What the frontend receives: same record with the password removed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeAccount {
    pub username: String,
    pub label: String,
    pub riot_id: String,
    pub region: String,
    pub notes: String,
    pub appear_offline: bool,
    pub auto_skin_random: bool,
    pub auto_champ_lock: String,
    pub has_password: bool,
    /// Whether the stored password can still be decrypted under the current
    /// key — never the password itself. Lets the card warn *before* a launch
    /// fails mid-flow, e.g. after a Windows update broke the old wmic-derived
    /// key.
    pub password_ok: bool,
    /// True once this account's honor has dropped below its observed peak.
    pub honor_flagged: bool,
}

/// A record as it appears inside an export blob — password in the clear, since
/// the blob itself is encrypted and has to be readable on another machine
/// (where the machine-bound key would not match).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableAccount {
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub riot_id: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub notes: String,
}

pub fn load() -> Vec<Account> {
    json_store::load(&paths::accounts_file(), "accounts").unwrap_or_default()
}

pub fn save(accounts: &[Account]) -> anyhow::Result<()> {
    json_store::save(&paths::accounts_file(), &accounts, "accounts")
}

pub fn list_safe() -> Vec<SafeAccount> {
    // The honor file is read once here, not per account: doing it inside the
    // loop would re-read and re-parse the whole thing for every row.
    let honor = crate::honor_watch::load();
    load()
        .iter()
        .map(|a| SafeAccount {
            username: a.username.clone(),
            label: a.label.clone(),
            riot_id: a.riot_id.clone(),
            region: a.region.clone(),
            notes: a.notes.clone(),
            appear_offline: a.appear_offline,
            auto_skin_random: a.auto_skin_random,
            auto_champ_lock: a.auto_champ_lock.clone(),
            has_password: !a.password.is_empty(),
            password_ok: !a.password.is_empty() && encryption::decrypt(&a.password).is_some(),
            honor_flagged: crate::honor_watch::is_flagged_record(honor.get(&a.username)),
        })
        .collect()
}

fn find_index(accounts: &[Account], username: &str) -> Option<usize> {
    accounts.iter().position(|a| a.username == username)
}

fn exists_ignoring_case(accounts: &[Account], username: &str) -> bool {
    let lower = username.to_lowercase();
    accounts.iter().any(|a| a.username.to_lowercase() == lower)
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountInput {
    pub username: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub riot_id: Option<String>,
    #[serde(default)]
    pub region: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub appear_offline: Option<bool>,
    #[serde(default)]
    pub auto_skin_random: Option<bool>,
    #[serde(default)]
    pub auto_champ_lock: Option<String>,
}

pub fn add(input: AccountInput) -> anyhow::Result<()> {
    let mut accounts = load();
    if input.username.trim().is_empty() {
        anyhow::bail!("Username is required");
    }
    // Case-insensitive: Riot logins are case-insensitive, and two records for
    // the same login would fight over per-account state.
    if exists_ignoring_case(&accounts, &input.username) {
        anyhow::bail!("An account with that username already exists");
    }
    let password = input.password.unwrap_or_default();
    accounts.push(Account {
        username: input.username,
        password: if password.is_empty() { String::new() } else { encryption::encrypt(&password) },
        label: input.label.unwrap_or_default(),
        riot_id: input.riot_id.unwrap_or_default(),
        region: input.region.unwrap_or_default(),
        notes: input.notes.unwrap_or_default(),
        appear_offline: input.appear_offline.unwrap_or(false),
        auto_skin_random: input.auto_skin_random.unwrap_or(false),
        auto_champ_lock: input.auto_champ_lock.unwrap_or_default(),
        extra: Default::default(),
    });
    save(&accounts)
}

/// Field-by-field update. An absent field keeps its stored value; an absent or
/// empty password keeps the stored ciphertext rather than blanking it.
pub fn update(input: AccountInput) -> anyhow::Result<()> {
    let mut accounts = load();
    let Some(i) = find_index(&accounts, &input.username) else {
        anyhow::bail!("Account not found");
    };
    let existing = accounts[i].clone();
    let account = &mut accounts[i];

    if let Some(p) = input.password.filter(|p| !p.is_empty()) {
        account.password = encryption::encrypt(&p);
    }
    if let Some(v) = input.label {
        account.label = v;
    }
    if let Some(v) = input.riot_id {
        account.riot_id = v;
    }
    if let Some(v) = input.region {
        account.region = v;
    }
    if let Some(v) = input.notes {
        account.notes = v;
    }
    if let Some(v) = input.appear_offline {
        account.appear_offline = v;
    }
    if let Some(v) = input.auto_skin_random {
        account.auto_skin_random = v;
    }
    if let Some(v) = input.auto_champ_lock {
        account.auto_champ_lock = v;
    }
    debug_assert_eq!(account.username, existing.username);
    save(&accounts)
}

pub fn delete(username: &str) -> anyhow::Result<()> {
    let mut accounts = load();
    let before = accounts.len();
    accounts.retain(|a| a.username != username);
    if accounts.len() == before {
        anyhow::bail!("Account not found");
    }
    save(&accounts)
}

/// Reorders to match `usernames`; anything not listed keeps its relative order
/// at the end, so a stale drag-and-drop payload can't drop accounts.
pub fn reorder(usernames: &[String]) -> anyhow::Result<()> {
    let accounts = load();
    let mut ordered: Vec<Account> = Vec::with_capacity(accounts.len());
    for name in usernames {
        if let Some(found) = accounts.iter().find(|a| &a.username == name) {
            ordered.push(found.clone());
        }
    }
    for account in &accounts {
        if !ordered.iter().any(|a| a.username == account.username) {
            ordered.push(account.clone());
        }
    }
    save(&ordered)
}

/// The only path that returns a plaintext password. The shell must check the
/// vault before calling it — the frontend lock screen alone is not a boundary.
pub fn reveal_password(username: &str) -> Option<String> {
    load()
        .iter()
        .find(|a| a.username == username)
        .and_then(|a| encryption::decrypt(&a.password))
}

/// Re-encrypts pre-v2 passwords under the current machine-bound key. Returns
/// how many were migrated.
pub fn migrate_legacy_passwords() -> anyhow::Result<usize> {
    let mut accounts = load();
    let mut migrated = 0;
    for account in accounts.iter_mut() {
        if account.password.is_empty() || account.password.starts_with("v2:") || account.password.starts_with("v3:") {
            continue;
        }
        if let Some(plain) = encryption::decrypt_legacy(&account.password) {
            account.password = encryption::encrypt(&plain);
            migrated += 1;
        }
    }
    if migrated > 0 {
        save(&accounts)?;
        tracing::info!("Migrated {migrated} password(s) to machine-bound encryption");
    }
    Ok(migrated)
}

pub fn export_blob() -> anyhow::Result<(String, usize)> {
    let accounts = load();
    let portable: Vec<PortableAccount> = accounts
        .iter()
        .map(|a| PortableAccount {
            username: a.username.clone(),
            // Decrypted on purpose: the machine-bound key won't exist on the
            // machine importing this. The blob as a whole is encrypted.
            password: encryption::decrypt(&a.password).unwrap_or_default(),
            label: a.label.clone(),
            riot_id: a.riot_id.clone(),
            region: a.region.clone(),
            notes: a.notes.clone(),
        })
        .collect();
    let count = portable.len();
    let blob = encryption::encrypt_export(&serde_json::json!({ "accounts": portable }))?;
    Ok((blob, count))
}

#[derive(Debug, Default, Serialize)]
pub struct ImportOutcome {
    pub imported: usize,
    pub skipped: usize,
}

/// Adds accounts from an export blob, skipping any username that already
/// exists. Existing records are never overwritten.
pub fn import_blob(blob: &str) -> anyhow::Result<ImportOutcome> {
    #[derive(Deserialize)]
    struct Payload {
        accounts: Vec<PortableAccount>,
    }
    let payload: Payload = encryption::decrypt_export(blob)
        .ok_or_else(|| anyhow::anyhow!("Not a valid Lost League export file"))?;

    let mut accounts = load();
    let mut outcome = ImportOutcome::default();
    for incoming in payload.accounts {
        if incoming.username.is_empty()
            || incoming.password.is_empty()
            || exists_ignoring_case(&accounts, &incoming.username)
        {
            outcome.skipped += 1;
            continue;
        }
        accounts.push(Account {
            username: incoming.username,
            password: encryption::encrypt(&incoming.password),
            label: incoming.label,
            riot_id: incoming.riot_id,
            region: incoming.region,
            notes: incoming.notes,
            appear_offline: false,
            auto_skin_random: false,
            auto_champ_lock: String::new(),
            extra: Default::default(),
        });
        outcome.imported += 1;
    }
    if outcome.imported > 0 {
        save(&accounts)?;
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::test_support::Sandbox;

    fn input(username: &str, password: &str) -> AccountInput {
        AccountInput {
            username: username.into(),
            password: Some(password.into()),
            ..Default::default()
        }
    }

    #[test]
    fn add_then_read_back_without_leaking_the_password() {
        let _sb = Sandbox::bare("add");
        add(input("summoner1", "pw1")).unwrap();

        let safe = list_safe();
        assert_eq!(safe.len(), 1);
        assert_eq!(safe[0].username, "summoner1");
        assert!(safe[0].has_password);
        assert!(safe[0].password_ok, "a freshly written password must be readable");
        assert!(!safe[0].honor_flagged);

        let json = serde_json::to_string(&safe).unwrap();
        assert!(!json.contains("pw1"), "safe listing must not carry passwords");
        assert!(!json.contains("password\":\"v3"), "not even the ciphertext");

        assert_eq!(reveal_password("summoner1").as_deref(), Some("pw1"));
    }

    #[test]
    fn stored_password_is_ciphertext_on_disk() {
        let _sb = Sandbox::bare("cipher");
        add(input("summoner", "plaintext-should-not-appear")).unwrap();
        let raw = std::fs::read_to_string(paths::accounts_file()).unwrap();
        assert!(!raw.contains("plaintext-should-not-appear"));
        assert!(raw.contains("v3:"));
    }

    #[test]
    fn duplicate_usernames_are_rejected_case_insensitively() {
        let _sb = Sandbox::bare("dupe");
        add(input("Summoner", "a")).unwrap();
        assert!(add(input("summoner", "b")).is_err());
        assert_eq!(load().len(), 1);
    }

    #[test]
    fn update_without_a_password_keeps_the_stored_one() {
        let _sb = Sandbox::bare("update");
        add(input("s", "original")).unwrap();
        update(AccountInput {
            username: "s".into(),
            password: Some(String::new()),
            label: Some("Main".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(reveal_password("s").as_deref(), Some("original"));
        assert_eq!(load()[0].label, "Main");
    }

    #[test]
    fn update_with_a_password_replaces_it() {
        let _sb = Sandbox::bare("update-pw");
        add(input("s", "original")).unwrap();
        update(AccountInput { username: "s".into(), password: Some("changed".into()), ..Default::default() }).unwrap();
        assert_eq!(reveal_password("s").as_deref(), Some("changed"));
    }

    #[test]
    fn delete_removes_only_the_named_account() {
        let _sb = Sandbox::bare("del");
        add(input("a", "1")).unwrap();
        add(input("b", "2")).unwrap();
        delete("a").unwrap();
        let left = load();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].username, "b");
        assert!(delete("nobody").is_err());
    }

    #[test]
    fn reorder_keeps_accounts_missing_from_the_payload() {
        let _sb = Sandbox::bare("order");
        for n in ["a", "b", "c"] {
            add(input(n, "x")).unwrap();
        }
        reorder(&["c".to_string(), "a".to_string()]).unwrap();
        let names: Vec<String> = load().into_iter().map(|a| a.username).collect();
        assert_eq!(names, vec!["c", "a", "b"], "b must survive a stale reorder");
    }

    #[test]
    fn unknown_fields_survive_a_save() {
        let _sb = Sandbox::bare("extra");
        let raw = r#"[{"username":"s","password":"","futureField":42}]"#;
        std::fs::write(paths::accounts_file(), raw).unwrap();
        update(AccountInput { username: "s".into(), label: Some("L".into()), ..Default::default() }).unwrap();
        let back = std::fs::read_to_string(paths::accounts_file()).unwrap();
        assert!(back.contains("futureField"), "a field this build doesn't know must not be dropped");
    }

    #[test]
    fn export_import_round_trip_across_machines() {
        let _sb = Sandbox::bare("export");
        add(input("carry", "secret")).unwrap();
        let (blob, count) = export_blob().unwrap();
        assert_eq!(count, 1);

        // Simulate importing on a different install: fresh store, same blob.
        _sb.switch_to("import");

        let outcome = import_blob(&blob).unwrap();
        assert_eq!((outcome.imported, outcome.skipped), (1, 0));
        assert_eq!(reveal_password("carry").as_deref(), Some("secret"));

        // Importing again changes nothing.
        let again = import_blob(&blob).unwrap();
        assert_eq!((again.imported, again.skipped), (0, 1));
    }

    #[test]
    fn import_rejects_a_file_that_is_not_an_export() {
        let _sb = Sandbox::bare("bad-import");
        assert!(import_blob("just some text").is_err());
    }
}
