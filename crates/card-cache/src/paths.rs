//! Paths depend on the user's platform, never the checkout or current directory.
use std::{env, path::PathBuf};

use anyhow::{Context, Result, ensure};

fn home() -> Result<PathBuf> {
    let home = env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .filter(|value| !value.is_empty())
        .context("user home directory is unavailable")?;
    let home = PathBuf::from(home);
    ensure!(home.is_absolute(), "user home directory must be absolute");
    Ok(home)
}

fn data_dir_for(home: PathBuf, platform: &str, override_dir: Option<PathBuf>) -> PathBuf {
    match platform {
        "macos" => home.join("Library/Application Support/17lands-zh"),
        "windows" => override_dir
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join("AppData/Local"))
            .join("17lands-zh"),
        _ => override_dir
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local/share"))
            .join("17lands-zh"),
    }
}

pub fn data_dir() -> Result<PathBuf> {
    let key = if cfg!(windows) {
        "LOCALAPPDATA"
    } else {
        "XDG_DATA_HOME"
    };
    let override_dir = env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute());
    if !cfg!(target_os = "macos")
        && let Some(directory) = override_dir.as_ref()
    {
        return Ok(directory.join("17lands-zh"));
    }
    Ok(data_dir_for(home()?, env::consts::OS, override_dir))
}

pub fn default_database() -> Result<PathBuf> {
    Ok(data_dir()?.join("cards.sqlite"))
}

pub(crate) fn launch_agents_dir() -> Result<PathBuf> {
    Ok(home()?.join("Library/LaunchAgents"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_paths_are_independent_of_checkout() {
        let home = PathBuf::from("/users/test");
        assert_eq!(
            data_dir_for(home.clone(), "macos", Some("/ignored".into())),
            home.join("Library/Application Support/17lands-zh")
        );
        assert_eq!(
            data_dir_for(home.clone(), "linux", Some("/data".into())),
            PathBuf::from("/data/17lands-zh")
        );
        for supplied in [None, Some(PathBuf::from("relative")), Some(PathBuf::new())] {
            assert_eq!(
                data_dir_for(home.clone(), "linux", supplied),
                home.join(".local/share/17lands-zh")
            );
        }
    }
}
