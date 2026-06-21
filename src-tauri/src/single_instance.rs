use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[cfg(unix)]
use std::fs::{File, OpenOptions};

#[cfg(unix)]
use nix::errno::Errno;
#[cfg(unix)]
use nix::fcntl::{Flock, FlockArg};

#[cfg(unix)]
pub type InstanceLock = Flock<File>;

pub struct SingleInstanceState {
    inner: Mutex<SingleInstanceInner>,
}

struct SingleInstanceInner {
    is_primary: bool,
    #[cfg(unix)]
    lock: Option<InstanceLock>,
}

pub enum LockStatus {
    #[cfg(unix)]
    Acquired(InstanceLock),
    // Only constructed on Unix (flock can detect a held lock). On Windows the
    // lock is currently a no-op that always returns FailedOpen (primary), so
    // this variant is never built there.
    #[cfg_attr(not(unix), allow(dead_code))]
    AlreadyRunning,
    FailedOpen,
}

impl SingleInstanceState {
    pub fn acquire_startup() -> Self {
        Self::from_status(acquire_lock_at(&default_lock_path()))
    }

    pub fn is_primary(&self) -> bool {
        self.lock_inner().is_primary
    }

    pub fn recheck_primary(&self) -> bool {
        let mut inner = self.lock_inner();
        if inner.is_primary {
            return true;
        }

        apply_lock_status(&mut inner, acquire_lock_at(&default_lock_path()))
    }

    fn from_status(status: LockStatus) -> Self {
        let mut inner = SingleInstanceInner {
            is_primary: false,
            #[cfg(unix)]
            lock: None,
        };
        apply_lock_status(&mut inner, status);
        Self {
            inner: Mutex::new(inner),
        }
    }

    fn lock_inner(&self) -> std::sync::MutexGuard<'_, SingleInstanceInner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn apply_lock_status(inner: &mut SingleInstanceInner, status: LockStatus) -> bool {
    match status {
        #[cfg(unix)]
        LockStatus::Acquired(lock) => {
            inner.is_primary = true;
            inner.lock = Some(lock);
            true
        }
        LockStatus::AlreadyRunning => false,
        LockStatus::FailedOpen => {
            inner.is_primary = true;
            true
        }
    }
}

pub fn default_lock_path() -> PathBuf {
    std::env::temp_dir().join("hq-installer.instance.lock")
}

pub fn acquire_lock_at(path: &Path) -> LockStatus {
    #[cfg(unix)]
    {
        let file = match OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
        {
            Ok(file) => file,
            Err(err) => {
                eprintln!(
                    "[hq-installer] failed to open instance lock file {}: {err}",
                    path.display()
                );
                return LockStatus::FailedOpen;
            }
        };

        match Flock::lock(file, FlockArg::LockExclusiveNonblock) {
            Ok(lock) => LockStatus::Acquired(lock),
            Err((_file, errno)) if errno == Errno::EWOULDBLOCK || errno == Errno::EAGAIN => {
                LockStatus::AlreadyRunning
            }
            Err((_file, errno)) => {
                eprintln!(
                    "[hq-installer] failed to acquire instance lock {}: {errno}",
                    path.display()
                );
                LockStatus::FailedOpen
            }
        }
    }

    #[cfg(not(unix))]
    {
        let _ = path;
        LockStatus::FailedOpen
    }
}

#[tauri::command]
pub fn is_primary_instance(state: tauri::State<'_, SingleInstanceState>) -> bool {
    state.is_primary()
}

#[tauri::command]
pub fn recheck_primary_instance(state: tauri::State<'_, SingleInstanceState>) -> bool {
    state.recheck_primary()
}

#[cfg(all(test, unix))]
mod tests {
    use super::{acquire_lock_at, LockStatus};

    #[cfg(unix)]
    #[test]
    fn second_lock_fails_until_first_guard_is_dropped() {
        let dir = tempfile::tempdir().expect("create temp dir");
        let lock_path = dir.path().join("hq-installer.instance.lock");

        let first = match acquire_lock_at(&lock_path) {
            LockStatus::Acquired(lock) => lock,
            LockStatus::AlreadyRunning => panic!("first lock unexpectedly blocked"),
            LockStatus::FailedOpen => panic!("first lock unexpectedly failed open"),
        };

        match acquire_lock_at(&lock_path) {
            LockStatus::AlreadyRunning => {}
            LockStatus::Acquired(_) => panic!("second lock unexpectedly succeeded"),
            LockStatus::FailedOpen => panic!("second lock unexpectedly failed open"),
        }

        drop(first);

        match acquire_lock_at(&lock_path) {
            LockStatus::Acquired(_) => {}
            LockStatus::AlreadyRunning => panic!("third lock still blocked after drop"),
            LockStatus::FailedOpen => panic!("third lock unexpectedly failed open"),
        }
    }
}
