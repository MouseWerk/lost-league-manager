//! The taskbar jump list: right-click the taskbar icon to launch an account
//! without opening the window.
//!
//! Windows exposes this only through COM (`ICustomDestinationList`), which is
//! why this is the one place in the app with `unsafe`. Every call is checked
//! and any failure is swallowed with a log line — a missing jump list is a
//! cosmetic loss, never a reason to fail a save or take the app down.

#![cfg(windows)]

use llm_core::accounts;
use windows::core::{Interface, PCWSTR, PROPVARIANT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW, ShellLink,
};

/// PKEY_Title — the text shown for a jump list entry.
const PKEY_TITLE: PROPERTYKEY = PROPERTYKEY {
    fmtid: windows::core::GUID::from_u128(0xf29f85e0_4ff9_1068_ab91_08002b27b3d9),
    pid: 2,
};

/// At most this many accounts get an entry, matching what the Electron build
/// published; the list has limited room and the tray menu covers the rest.
const MAX_ENTRIES: usize = 5;

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Builds one "Launch <account>" task.
unsafe fn make_task(exe: &str, username: &str, title: &str) -> windows::core::Result<IShellLinkW> {
    let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;

    let exe_w = wide(exe);
    link.SetPath(PCWSTR(exe_w.as_ptr()))?;
    // Same contract the Electron build used, so the argument handling in main
    // stays one code path.
    let args_w = wide(&format!("--launch={username}"));
    link.SetArguments(PCWSTR(args_w.as_ptr()))?;
    let icon_w = wide(exe);
    link.SetIconLocation(PCWSTR(icon_w.as_ptr()), 0)?;
    let desc_w = wide(&format!("Login to {title}"));
    link.SetDescription(PCWSTR(desc_w.as_ptr()))?;

    // The visible label lives in the property store, not on the link itself.
    let store: IPropertyStore = link.cast()?;
    store.SetValue(&PKEY_TITLE, &PROPVARIANT::from(title))?;
    store.Commit()?;

    Ok(link)
}

unsafe fn build() -> windows::core::Result<()> {
    // The app's own threads are not COM-initialised; apartment-threaded is what
    // the shell interfaces expect. Already-initialised is not an error here.
    let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    if exe.is_empty() {
        return Ok(());
    }

    let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
    let mut slots: u32 = 0;
    // BeginList hands back the items the user has removed by hand; they must be
    // left out or AddUserTasks fails.
    let _removed: IObjectArray = list.BeginList(&mut slots)?;

    let collection: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
    for account in accounts::load().iter().take(MAX_ENTRIES) {
        let title = if account.label.is_empty() { &account.username } else { &account.label };
        match make_task(&exe, &account.username, title) {
            Ok(link) => collection.AddObject(&link)?,
            Err(e) => tracing::warn!("[JumpList] Skipping {}: {e}", account.username),
        }
    }

    let tasks: IObjectArray = collection.cast()?;
    list.AddUserTasks(&tasks)?;
    list.CommitList()?;
    Ok(())
}

/// Rebuilds the jump list. Safe to call whenever the account list changes.
pub fn refresh() {
    if let Err(e) = unsafe { build() } {
        tracing::warn!("[JumpList] Could not update: {e}");
    }
}
