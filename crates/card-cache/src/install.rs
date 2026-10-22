//! Transactional user LaunchAgent lifecycle. No database is opened or migrated here.
use std::{
    fs::{self, File},
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use tempfile::NamedTempFile;

use crate::paths;

pub const LABEL: &str = "com.seventeenlands-zh.card-cache";

#[derive(Debug)]
struct Paths {
    base: PathBuf,
    binary: PathBuf,
    database: PathBuf,
    plist: PathBuf,
}

impl Paths {
    fn resolve(database: Option<&Path>) -> Result<Self> {
        let base = paths::data_dir()?;
        let database = match database {
            Some(path) => std::path::absolute(path)?,
            None => base.join("cards.sqlite"),
        };
        Ok(Self {
            binary: base.join("bin/mtga-card-cache"),
            database,
            plist: paths::launch_agents_dir()?.join(format!("{LABEL}.plist")),
            base,
        })
    }
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn plist(paths: &Paths) -> Result<String> {
    let string = |path: &Path| -> Result<String> {
        let value = path.to_str().context("LaunchAgent paths must be UTF-8")?;
        ensure!(
            value
                .chars()
                .all(|c| matches!(c, '\t' | '\n' | '\r') || c >= ' '),
            "LaunchAgent paths contain XML control characters"
        );
        Ok(xml(value))
    };
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
         <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
         <plist version=\"1.0\"><dict>\n\
         <key>Label</key><string>{LABEL}</string>\n\
         <key>ProgramArguments</key><array><string>{}</string><string>serve</string><string>--db</string><string>{}</string></array>\n\
         <key>WorkingDirectory</key><string>{}</string>\n\
         <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n\
         <key>ThrottleInterval</key><integer>30</integer>\n\
         <key>StandardOutPath</key><string>{}</string>\n\
         <key>StandardErrorPath</key><string>{}</string>\n\
         </dict></plist>\n",
        string(&paths.binary)?,
        string(&paths.database)?,
        string(&paths.base)?,
        string(&paths.base.join("server.log"))?,
        string(&paths.base.join("server-error.log"))?,
    ))
}

trait Agent {
    fn loaded(&mut self) -> Result<bool>;
    fn bootout(&mut self) -> Result<()>;
    fn bootstrap(&mut self, plist: &Path) -> Result<()>;
}

struct Launchctl;

fn domain() -> Result<String> {
    #[cfg(target_os = "macos")]
    {
        // SAFETY: getuid has no preconditions or side effects.
        Ok(format!("gui/{}", unsafe { libc::getuid() }))
    }
    #[cfg(not(target_os = "macos"))]
    bail!("LaunchAgent installation is only supported on macOS; run mtga-card-cache serve directly")
}

fn launchctl(args: &[&str]) -> Result<()> {
    let result = Command::new("launchctl").args(args).output()?;
    ensure!(
        result.status.success(),
        "launchctl {}: {}",
        args.join(" "),
        String::from_utf8_lossy(&result.stderr).trim()
    );
    Ok(())
}

impl Agent for Launchctl {
    fn loaded(&mut self) -> Result<bool> {
        Ok(Command::new("launchctl")
            .args(["print", &format!("{}/{LABEL}", domain()?)])
            .output()?
            .status
            .success())
    }

    fn bootout(&mut self) -> Result<()> {
        launchctl(&["bootout", &format!("{}/{LABEL}", domain()?)])
    }

    fn bootstrap(&mut self, plist: &Path) -> Result<()> {
        launchctl(&[
            "bootstrap",
            &domain()?,
            plist.to_str().context("plist path must be UTF-8")?,
        ])
    }
}

#[cfg(unix)]
fn permissions(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::set_permissions(path, fs::Permissions::from_mode(mode))?)
}

#[cfg(not(unix))]
fn permissions(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

fn lock(paths: &Paths) -> Result<File> {
    fs::create_dir_all(&paths.base)?;
    permissions(&paths.base, 0o700)?;
    let file = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(paths.base.join("install.lock"))?;
    fs2::FileExt::try_lock_exclusive(&file)
        .context("card-cache installation is already in progress")?;
    Ok(file)
}

fn stage_copy(source: &Path, target: &Path) -> Result<NamedTempFile> {
    let staged = NamedTempFile::new_in(target.parent().context("missing target directory")?)?;
    fs::copy(source, staged.path())?;
    staged.as_file().sync_all()?;
    Ok(staged)
}

fn backup(path: &Path) -> Result<Option<NamedTempFile>> {
    match fs::metadata(path) {
        Ok(_) => Ok(Some(stage_copy(path, path)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn restore(path: &Path, backup: Option<NamedTempFile>) -> Result<()> {
    if let Some(backup) = backup {
        backup.persist(path).map_err(|error| error.error)?;
    } else if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

fn install_files(
    paths: &Paths,
    source: &Path,
    document: &str,
    agent: &mut impl Agent,
) -> Result<()> {
    let _lock = lock(paths)?;
    fs::create_dir_all(paths.binary.parent().context("missing binary directory")?)?;
    fs::create_dir_all(
        paths
            .plist
            .parent()
            .context("missing LaunchAgents directory")?,
    )?;
    // Both replacement files and recoverable backups exist before touching the running job.
    // Disk copies keep installation memory bounded even for a large executable.
    let staged = stage_copy(source, &paths.binary)?;
    permissions(staged.path(), 0o755)?;
    let mut staged_plist = NamedTempFile::new_in(paths.plist.parent().unwrap())?;
    staged_plist.write_all(document.as_bytes())?;
    permissions(staged_plist.path(), 0o644)?;
    staged_plist.as_file().sync_all()?;
    let prior_binary = backup(&paths.binary)?;
    let prior_plist = backup(&paths.plist)?;
    let was_loaded = agent.loaded()?;
    if was_loaded {
        agent.bootout()?;
    }
    let result = (|| -> Result<()> {
        staged.persist(&paths.binary).map_err(|error| error.error)?;
        staged_plist
            .persist(&paths.plist)
            .map_err(|error| error.error)?;
        agent.bootstrap(&paths.plist)
    })();
    if let Err(cause) = result {
        let rollback = (|| -> Result<()> {
            // A failed bootstrap can still leave a registered job. Stop it before restoration.
            if agent.loaded()? {
                agent.bootout()?;
            }
            restore(&paths.binary, prior_binary)?;
            restore(&paths.plist, prior_plist)?;
            if was_loaded {
                agent.bootstrap(&paths.plist)?;
            }
            Ok(())
        })();
        if let Err(error) = rollback {
            bail!("installation failed: {cause:#}; rollback failed: {error:#}");
        }
        return Err(cause);
    }
    Ok(())
}

fn uninstall_files(paths: &Paths, agent: &mut impl Agent) -> Result<()> {
    let _lock = lock(paths)?;
    if agent.loaded()? {
        agent.bootout()?;
    }
    match fs::remove_file(&paths.plist) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn require_macos() -> Result<()> {
    ensure!(
        cfg!(target_os = "macos"),
        "LaunchAgent installation is only supported on macOS; run mtga-card-cache serve directly"
    );
    Ok(())
}

pub fn install(database: Option<&Path>, dry_run: bool) -> Result<Value> {
    require_macos()?;
    let paths = Paths::resolve(database)?;
    let source = std::env::current_exe().context("cannot resolve current executable")?;
    let document = plist(&paths)?;
    if !dry_run {
        install_files(&paths, &source, &document, &mut Launchctl)?;
    }
    Ok(
        json!({"installed":!dry_run,"dry_run":dry_run,"label":LABEL,"database":paths.database,"binary":paths.binary,"plist":paths.plist,"plist_xml":document,"url":"http://127.0.0.1:17317"}),
    )
}

pub fn uninstall(database: Option<&Path>, dry_run: bool) -> Result<Value> {
    require_macos()?;
    let paths = Paths::resolve(database)?;
    if !dry_run {
        uninstall_files(&paths, &mut Launchctl)?;
    }
    Ok(
        json!({"stopped":!dry_run,"dry_run":dry_run,"label":LABEL,"plist":paths.plist,"database_preserved":paths.database,"binary_preserved":paths.binary}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeAgent {
        loaded: bool,
        fail_bootstrap: bool,
        starts: usize,
        stops: usize,
    }
    impl Agent for FakeAgent {
        fn loaded(&mut self) -> Result<bool> {
            Ok(self.loaded)
        }
        fn bootout(&mut self) -> Result<()> {
            self.stops += 1;
            self.loaded = false;
            Ok(())
        }
        fn bootstrap(&mut self, _plist: &Path) -> Result<()> {
            self.starts += 1;
            self.loaded = true;
            if std::mem::take(&mut self.fail_bootstrap) {
                bail!("simulated bootstrap failure");
            }
            Ok(())
        }
    }

    fn fixture(root: &Path) -> Paths {
        Paths {
            base: root.join("data & files"),
            binary: root.join("data & files/bin/mtga-card-cache"),
            database: root.join("data & files/cards.sqlite"),
            plist: root.join("agents/service.plist"),
        }
    }

    #[test]
    fn plist_escapes_paths_and_keeps_one_continuous_server() -> Result<()> {
        let paths = fixture(Path::new("/fixture"));
        let value = plist(&paths)?;
        assert!(value.contains("data &amp; files/cards.sqlite"));
        assert!(value.contains(LABEL));
        assert!(value.contains("<key>KeepAlive</key><true/>"));
        assert!(!value.contains("StartInterval"));
        assert!(value.contains("<string>serve</string><string>--db</string>"));
        Ok(())
    }

    #[test]
    fn update_rolls_back_files_permissions_and_previous_job() -> Result<()> {
        let root = tempfile::tempdir()?;
        let paths = fixture(root.path());
        let source = root.path().join("source");
        fs::write(&source, b"first")?;
        let mut agent = FakeAgent::default();
        install_files(&paths, &source, "old plist", &mut agent)?;
        fs::write(&paths.database, b"untouched database")?;
        fs::write(&source, b"second")?;
        agent.fail_bootstrap = true;
        assert!(install_files(&paths, &source, "new plist", &mut agent).is_err());
        assert_eq!(fs::read(&paths.binary)?, b"first");
        assert_eq!(fs::read(&paths.plist)?, b"old plist");
        assert_eq!(fs::read(&paths.database)?, b"untouched database");
        assert!(agent.loaded);
        assert_eq!(agent.starts, 3);
        assert_eq!(agent.stops, 2);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&paths.binary)?.permissions().mode() & 0o777,
                0o755
            );
        }
        uninstall_files(&paths, &mut agent)?;
        uninstall_files(&paths, &mut agent)?;
        assert!(!paths.plist.exists());
        assert!(paths.binary.exists());
        assert_eq!(fs::read(&paths.database)?, b"untouched database");
        Ok(())
    }

    #[test]
    fn first_install_failure_removes_new_files() -> Result<()> {
        let root = tempfile::tempdir()?;
        let paths = fixture(root.path());
        let source = root.path().join("source");
        fs::write(&source, b"binary")?;
        let mut agent = FakeAgent {
            fail_bootstrap: true,
            ..Default::default()
        };
        assert!(install_files(&paths, &source, "plist", &mut agent).is_err());
        assert!(!paths.binary.exists());
        assert!(!paths.plist.exists());
        assert!(!agent.loaded);
        Ok(())
    }

    #[test]
    fn lifecycle_lock_and_staging_failures_leave_running_job_untouched() -> Result<()> {
        let root = tempfile::tempdir()?;
        let paths = fixture(root.path());
        let held = lock(&paths)?;
        let mut agent = FakeAgent {
            loaded: true,
            ..Default::default()
        };
        assert!(uninstall_files(&paths, &mut agent).is_err());
        assert!(install_files(&paths, &root.path().join("missing"), "plist", &mut agent).is_err());
        drop(held);
        assert!(install_files(&paths, &root.path().join("missing"), "plist", &mut agent).is_err());
        assert_eq!(agent.stops, 0);
        assert!(agent.loaded);
        Ok(())
    }

    #[test]
    #[cfg(not(target_os = "macos"))]
    fn lifecycle_rejects_other_platforms_even_in_dry_run() {
        assert!(install(None, true).is_err());
        assert!(uninstall(None, true).is_err());
    }
}
