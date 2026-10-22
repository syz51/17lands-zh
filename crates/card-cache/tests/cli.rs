use std::{fs, path::Path, process::Command};

use anyhow::Result;
use mtga_card_cache::db::Writer;

fn cli(home: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_mtga-card-cache"));
    command
        .env("HOME", home)
        .env("USERPROFILE", home)
        .env_remove("XDG_DATA_HOME")
        .env_remove("LOCALAPPDATA");
    command
}

#[test]
fn status_uses_platform_database_and_accepts_global_override() -> Result<()> {
    let home = tempfile::tempdir()?;
    let directory = if cfg!(target_os = "macos") {
        home.path().join("Library/Application Support/17lands-zh")
    } else if cfg!(windows) {
        home.path().join("AppData/Local/17lands-zh")
    } else {
        home.path().join(".local/share/17lands-zh")
    };
    drop(Writer::open(directory.join("cards.sqlite"))?);
    let output = cli(home.path()).arg("status").output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
    assert_eq!(value["card_count"], 0);
    assert_eq!(value["journal_mode"], "wal");
    let database = home.path().join("custom.sqlite");
    drop(Writer::open(&database)?);
    for before in [true, false] {
        let mut command = cli(home.path());
        if before {
            command.arg("--db").arg(&database).arg("status");
        } else {
            command.arg("status").arg("--db").arg(&database);
        }
        assert!(command.output()?.status.success());
    }
    Ok(())
}

#[test]
#[cfg(target_os = "linux")]
fn xdg_data_home_does_not_require_home() -> Result<()> {
    let directory = tempfile::tempdir()?;
    drop(Writer::open(
        directory.path().join("17lands-zh/cards.sqlite"),
    )?);
    let output = cli(directory.path())
        .env_remove("HOME")
        .env("XDG_DATA_HOME", directory.path())
        .arg("status")
        .output()?;
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    Ok(())
}

#[test]
fn lifecycle_dry_runs_have_no_filesystem_or_launchctl_side_effects() -> Result<()> {
    let home = tempfile::tempdir()?;
    for verb in ["install", "uninstall"] {
        // An empty PATH makes any accidental launchctl invocation fail this test.
        let output = cli(home.path())
            .env("PATH", "")
            .args([verb, "--dry-run"])
            .output()?;
        if cfg!(target_os = "macos") {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
            assert_eq!(value["dry_run"], true);
            assert_eq!(value["label"], "com.seventeenlands-zh.card-cache");
        } else {
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains("only supported on macOS"));
        }
        assert_eq!(fs::read_dir(home.path())?.count(), 0);
    }
    #[cfg(target_os = "macos")]
    {
        let output = cli(home.path())
            .env("PATH", "")
            .current_dir(home.path())
            .args(["--db", "custom.sqlite", "install", "--dry-run"])
            .output()?;
        assert!(output.status.success());
        let value: serde_json::Value = serde_json::from_slice(&output.stdout)?;
        assert_eq!(
            value["database"],
            home.path()
                .canonicalize()?
                .join("custom.sqlite")
                .to_str()
                .unwrap()
        );
        assert!(
            value["plist_xml"]
                .as_str()
                .unwrap()
                .contains("custom.sqlite")
        );
        assert_eq!(fs::read_dir(home.path())?.count(), 0);
    }
    Ok(())
}

#[test]
fn public_listen_requires_explicit_host_policy_before_opening_database() -> Result<()> {
    let home = tempfile::tempdir()?;
    let output = cli(home.path())
        .env_remove("CARD_CACHE_ALLOWED_HOSTS")
        .args(["serve", "--listen", "0.0.0.0:17317"])
        .output()?;
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("requires explicit --allowed-hosts"));
    assert_eq!(fs::read_dir(home.path())?.count(), 0);
    Ok(())
}
