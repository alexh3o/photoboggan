//! Platform-specific OS layer for SD card and external folder import:
//! removable volume enumeration, free disk space, safe ejection, storage-kind
//! classification, and event-driven OS device watching (Windows & Linux/Unix).

#[cfg(not(windows))]
use std::collections::{HashMap, HashSet};
#[cfg(not(windows))]
use std::fs;
use std::path::Path;
#[cfg(not(windows))]
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

#[cfg(not(windows))]
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_string()
}

// ---------------------------------------------------------------------------
// Platform-specific removable drive enumeration, free space & ejection
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct RawRemovableVolume {
    pub(crate) media_id: String,
    pub(crate) label: String,
    pub(crate) root_path: String,
}

#[cfg(windows)]
pub(crate) fn enumerate_removable_volumes() -> Vec<RawRemovableVolume> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};

    const DRIVE_REMOVABLE: u32 = 2;
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for bit in 0..26u32 {
        if (mask & (1 << bit)) == 0 {
            continue;
        }
        let letter = (b'A' + bit as u8) as char;
        let root_str = format!("{letter}:\\");
        let wide: Vec<u16> = OsString::from(&root_str).encode_wide().chain(Some(0)).collect();
        let dtype = unsafe { GetDriveTypeW(PCWSTR(wide.as_ptr())) };
        if dtype != DRIVE_REMOVABLE {
            continue;
        }
        let mut vol_name = [0u16; 261];
        let mut serial: u32 = 0;
        let ok = unsafe {
            GetVolumeInformationW(
                PCWSTR(wide.as_ptr()),
                Some(&mut vol_name),
                Some(&raw mut serial),
                None,
                None,
                None,
            )
        };
        if ok.is_err() {
            continue;
        }
        let name_len = vol_name.iter().position(|&c| c == 0).unwrap_or(vol_name.len());
        let label = OsString::from_wide(&vol_name[..name_len])
            .to_string_lossy()
            .trim()
            .to_string();
        let media_id = if serial != 0 {
            format!("{:04X}-{:04X}", (serial >> 16) & 0xFFFF, serial & 0xFFFF)
        } else {
            format!("drive:{letter}")
        };
        out.push(RawRemovableVolume {
            media_id,
            label: if label.is_empty() {
                format!("{letter}:")
            } else {
                label
            },
            root_path: root_str,
        });
    }
    out
}

#[cfg(not(windows))]
struct ProcMount {
    dev: String,
    mount_point: String,
    fstype: String,
}

#[cfg(not(windows))]
fn unescape_mount_field(raw: &str) -> String {
    raw.replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\")
}

#[cfg(not(windows))]
fn read_proc_mounts() -> Result<Vec<ProcMount>, String> {
    let mounts = fs::read_to_string("/proc/mounts").map_err(|e| e.to_string())?;
    Ok(mounts
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let dev = unescape_mount_field(parts.next()?);
            let mount_point = unescape_mount_field(parts.next()?);
            let fstype = parts.next()?.to_string();
            Some(ProcMount { dev, mount_point, fstype })
        })
        .collect())
}

#[cfg(not(windows))]
pub(crate) fn enumerate_removable_volumes() -> Vec<RawRemovableVolume> {
    let Ok(mounts) = read_proc_mounts() else {
        return Vec::new();
    };
    let uuid_map = read_linux_disk_links("/dev/disk/by-uuid");
    let label_map = read_linux_disk_links("/dev/disk/by-label");
    let mut out = Vec::new();
    let mut seen_roots = HashSet::new();
    for m in mounts {
        if !m.dev.starts_with("/dev/") {
            continue;
        }
        if !seen_roots.insert(m.mount_point.clone()) {
            continue;
        }
        let is_user_media = m.mount_point.starts_with("/media/") || m.mount_point.starts_with("/run/media/");
        let is_removable_sys = linux_dev_is_removable(&m.dev);
        if !is_user_media && !is_removable_sys {
            continue;
        }
        let canon_dev = fs::canonicalize(&m.dev).unwrap_or_else(|_| PathBuf::from(&m.dev));
        let media_id = uuid_map
            .get(&canon_dev)
            .cloned()
            .unwrap_or_else(|| format!("dev:{}", canon_dev.to_string_lossy()));
        let label = label_map
            .get(&canon_dev)
            .cloned()
            .or_else(|| {
                Path::new(&m.mount_point)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| m.mount_point.clone());
        out.push(RawRemovableVolume {
            media_id,
            label,
            root_path: m.mount_point,
        });
    }
    out
}

#[cfg(not(windows))]
fn read_linux_disk_links(dir: &str) -> HashMap<PathBuf, String> {
    let mut map = HashMap::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return map;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        if let Ok(target) = fs::canonicalize(entry.path()) {
            map.insert(target, entry.file_name().to_string_lossy().into_owned());
        }
    }
    map
}

#[cfg(not(windows))]
fn linux_dev_is_removable(dev: &str) -> bool {
    let name = Path::new(dev)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let base = name.trim_end_matches(|c: char| c.is_ascii_digit());
    let base = base.strip_suffix('p').filter(|b| b.starts_with("mmcblk") || b.starts_with("nvme")).unwrap_or(base);
    let sys_path = format!("/sys/block/{base}/removable");
    fs::read_to_string(sys_path)
        .map(|s| s.trim() == "1")
        .unwrap_or(false)
}

#[cfg(windows)]
pub(crate) fn disk_free_space(path: &Path) -> Result<u64, String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let wide: Vec<u16> = OsStr::new(path).encode_wide().chain(Some(0)).collect();
    let mut free_available: u64 = 0;
    unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), Some(&raw mut free_available), None, None) }
        .map_err(|e| format!("Cannot read free disk space: {e}"))?;
    Ok(free_available)
}

#[cfg(not(windows))]
pub(crate) fn disk_free_space(path: &Path) -> Result<u64, String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let c_path = CString::new(path.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return Err("Cannot read free disk space".into());
    }
    Ok(stat.f_bavail as u64 * stat.f_frsize as u64)
}

#[cfg(windows)]
pub(crate) fn eject_removable_volume(root_path: &str) -> Result<(), String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, GetDriveTypeW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    use windows::Win32::System::Ioctl::{
        FSCTL_DISMOUNT_VOLUME, FSCTL_LOCK_VOLUME, IOCTL_STORAGE_EJECT_MEDIA,
        IOCTL_STORAGE_MEDIA_REMOVAL,
    };
    use windows::Win32::System::IO::DeviceIoControl;

    const DRIVE_REMOVABLE: u32 = 2;
    let mut chars = root_path.chars();
    let letter = chars
        .next()
        .filter(char::is_ascii_alphabetic)
        .ok_or_else(|| "Lecteur amovible invalide".to_string())?;
    if chars.next() != Some(':') {
        return Err("Lecteur amovible invalide".to_string());
    }
    let root_drive = format!("{letter}:\\");
    let wide_drive: Vec<u16> = OsString::from(&root_drive).encode_wide().chain(Some(0)).collect();
    if unsafe { GetDriveTypeW(PCWSTR(wide_drive.as_ptr())) } != DRIVE_REMOVABLE {
        return Err("Ce support n'est pas un lecteur amovible éjectable".to_string());
    }
    let device_path = format!("\\\\.\\{letter}:");
    let wide: Vec<u16> = OsString::from(&device_path).encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            PCWSTR(wide.as_ptr()),
            GENERIC_READ.0 | GENERIC_WRITE.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            None,
            OPEN_EXISTING,
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES::default(),
            None,
        )
    }
    .map_err(|e| format!("Impossible d'ouvrir le volume pour éjection : {e}"))?;

    let result = (|| -> Result<(), String> {
        let mut bytes = 0u32;
        unsafe {
            DeviceIoControl(handle, FSCTL_LOCK_VOLUME, None, 0, None, 0, Some(&raw mut bytes), None)
                .map_err(|_| "Le support est utilisé par un autre programme : fermez les fenêtres ouvertes dessus et réessayez".to_string())?;
            DeviceIoControl(handle, FSCTL_DISMOUNT_VOLUME, None, 0, None, 0, Some(&raw mut bytes), None)
                .map_err(|e| format!("Démontage du volume refusé par le système : {e}"))?;
            let prevent: [u8; 1] = [0];
            let _ = DeviceIoControl(
                handle,
                IOCTL_STORAGE_MEDIA_REMOVAL,
                Some(prevent.as_ptr().cast()),
                1,
                None,
                0,
                Some(&raw mut bytes),
                None,
            );
            DeviceIoControl(handle, IOCTL_STORAGE_EJECT_MEDIA, None, 0, None, 0, Some(&raw mut bytes), None)
                .map_err(|e| format!("Éjection refusée par le système : {e}"))?;
        }
        Ok(())
    })();
    unsafe {
        let _ = CloseHandle(handle);
    }
    result
}

#[cfg(not(windows))]
pub(crate) fn eject_removable_volume(root_path: &str) -> Result<(), String> {
    let mounts = read_proc_mounts()?;
    let norm_target = normalize_path(root_path);
    let (dev, mount) = mounts
        .into_iter()
        .find_map(|m| {
            (normalize_path(&m.mount_point) == norm_target).then_some((m.dev, m.mount_point))
        })
        .ok_or_else(|| "Point de montage introuvable".to_string())?;
    let is_removable = dev.starts_with("/dev/")
        && (mount.starts_with("/media/")
            || mount.starts_with("/run/media/")
            || linux_dev_is_removable(&dev));
    if !is_removable {
        return Err("Ce support n'est pas un lecteur amovible éjectable".to_string());
    }
    let unmount = std::process::Command::new("udisksctl")
        .args(["unmount", "-b", &dev])
        .output()
        .map_err(|e| format!("udisksctl indisponible : {e}"))?;
    if !unmount.status.success() {
        return Err(String::from_utf8_lossy(&unmount.stderr).trim().to_string());
    }
    let _ = std::process::Command::new("udisksctl")
        .args(["power-off", "-b", &dev])
        .output();
    Ok(())
}

/// Classifies a source path as `"removable"`, `"network"`, or `"internal"`.
pub(crate) fn detect_storage_kind(path: &Path) -> &'static str {
    let raw = path.to_string_lossy();
    #[cfg(windows)]
    {
        if raw.starts_with("\\\\") {
            return "network";
        }
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::Storage::FileSystem::{
            CreateFileW, GetDriveTypeW, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
        };
        use windows::Win32::System::IO::DeviceIoControl;

        const DRIVE_REMOVABLE: u32 = 2;
        const DRIVE_FIXED: u32 = 3;
        const DRIVE_REMOTE: u32 = 4;
        const IOCTL_STORAGE_QUERY_PROPERTY: u32 = 0x002D1400;

        let mut chars = raw.chars();
        let Some(letter) = chars.next().filter(char::is_ascii_alphabetic) else {
            return "internal";
        };
        if chars.next() != Some(':') {
            return "internal";
        }
        let root_str = format!("{letter}:\\");
        let wide_root: Vec<u16> = OsString::from(&root_str).encode_wide().chain(Some(0)).collect();
        let dtype = unsafe { GetDriveTypeW(PCWSTR(wide_root.as_ptr())) };
        if dtype == DRIVE_REMOVABLE {
            return "removable";
        }
        if dtype == DRIVE_REMOTE {
            return "network";
        }
        if dtype == DRIVE_FIXED {
            #[repr(C)]
            struct StoragePropertyQuery {
                property_id: u32,
                query_type: u32,
                additional_parameters: [u8; 4],
            }
            let dev_path = format!("\\\\.\\{letter}:");
            let wide_dev: Vec<u16> = OsString::from(&dev_path).encode_wide().chain(Some(0)).collect();
            if let Ok(handle) = unsafe {
                CreateFileW(
                    PCWSTR(wide_dev.as_ptr()),
                    0,
                    FILE_SHARE_READ | FILE_SHARE_WRITE,
                    None,
                    OPEN_EXISTING,
                    windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES::default(),
                    None,
                )
            } {
                let query = StoragePropertyQuery {
                    property_id: 0, // StorageDeviceProperty
                    query_type: 0,  // PropertyStandardQuery
                    additional_parameters: [0; 4],
                };
                let mut desc = [0u8; 256];
                let mut returned = 0u32;
                let ok = unsafe {
                    DeviceIoControl(
                        handle,
                        IOCTL_STORAGE_QUERY_PROPERTY,
                        Some((&raw const query).cast()),
                        std::mem::size_of::<StoragePropertyQuery>() as u32,
                        Some(desc.as_mut_ptr().cast()),
                        desc.len() as u32,
                        Some(&raw mut returned),
                        None,
                    )
                };
                unsafe {
                    let _ = CloseHandle(handle);
                }
                if ok.is_ok() && returned >= 32 {
                    // STORAGE_DEVICE_DESCRIPTOR.BusType is at offset 28 (7=USB, 12=SD, 13=MMC).
                    let bus_type = desc[28];
                    if matches!(bus_type, 7 | 12 | 13) {
                        return "removable";
                    }
                }
            }
        }
        "internal"
    }
    #[cfg(not(windows))]
    {
        let _ = raw;
        let canon = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let canon_norm = normalize_path(&canon.to_string_lossy());
        let Ok(mounts) = read_proc_mounts() else {
            return "internal";
        };
        let mut best: Option<(usize, String, String, String)> = None;
        for m in mounts {
            let mount = normalize_path(&m.mount_point);
            let matches = if mount.is_empty() {
                true
            } else {
                canon_norm == mount || canon_norm.starts_with(&format!("{mount}/"))
            };
            if matches && best.as_ref().is_none_or(|b| mount.len() > b.0) {
                best = Some((mount.len(), m.dev, mount, m.fstype));
            }
        }
        if let Some((_, dev, mount, fstype)) = best {
            if matches!(fstype.as_str(), "cifs" | "smb3" | "nfs" | "nfs4" | "fuse.sshfs" | "sshfs" | "davfs") {
                return "network";
            }
            if mount.starts_with("/media/")
                || mount.starts_with("/run/media/")
                || dev.starts_with("/dev/mmcblk")
                || linux_dev_is_removable(&dev)
            {
                return "removable";
            }
        }
        "internal"
    }
}

// ---------------------------------------------------------------------------
// OS event-driven device watcher (zero polling at rest)
// ---------------------------------------------------------------------------

struct WatcherState {
    stop: Arc<AtomicBool>,
    #[cfg(windows)]
    hwnd_raw: usize,
    #[cfg(not(windows))]
    wake_write_fd: std::os::unix::io::RawFd,
    join: Option<std::thread::JoinHandle<()>>,
}

static WATCHER: OnceLock<Mutex<Option<WatcherState>>> = OnceLock::new();

fn watcher_lock() -> &'static Mutex<Option<WatcherState>> {
    WATCHER.get_or_init(|| Mutex::new(None))
}

pub(crate) fn is_watcher_running() -> bool {
    watcher_lock()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .is_some()
}

pub fn stop_device_watcher() {
    let mut guard = watcher_lock().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(mut state) = guard.take() {
        state.stop.store(true, Ordering::SeqCst);
        #[cfg(windows)]
        if state.hwnd_raw != 0 {
            use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
            unsafe {
                let _ = PostMessageW(Some(HWND(state.hwnd_raw as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
        #[cfg(not(windows))]
        if state.wake_write_fd >= 0 {
            unsafe {
                let byte: u8 = 1;
                let _ = libc::write(state.wake_write_fd, &byte as *const u8 as *const libc::c_void, 1);
                let _ = libc::close(state.wake_write_fd);
            }
        }
        if let Some(handle) = state.join.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(windows)]
pub(crate) fn start_device_watcher(mut on_change: impl FnMut() + Send + 'static) {
    use std::cell::RefCell;
    use windows::core::w;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        PostQuitMessage, RegisterClassW, TranslateMessage, MSG, WINDOW_EX_STYLE,
        WINDOW_STYLE, WM_CLOSE, WM_DESTROY, WM_DEVICECHANGE, WNDCLASSW,
    };

    const DBT_DEVNODES_CHANGED: usize = 0x0007;
    const DBT_DEVICEARRIVAL: usize = 0x8000;
    const DBT_DEVICEREMOVECOMPLETE: usize = 0x8004;

    thread_local! {
        static HANDLER: RefCell<Option<Box<dyn FnMut()>>> = RefCell::new(None);
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_DEVICECHANGE => {
                if matches!(wparam.0, DBT_DEVICEARRIVAL | DBT_DEVICEREMOVECOMPLETE | DBT_DEVNODES_CHANGED) {
                    HANDLER.with(|cell| {
                        if let Some(cb) = cell.borrow_mut().as_mut() {
                            cb();
                        }
                    });
                }
                LRESULT(1)
            }
            WM_CLOSE => {
                let _ = DestroyWindow(hwnd);
                LRESULT(0)
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                LRESULT(0)
            }
            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();
    let (tx, rx) = std::sync::mpsc::channel::<usize>();

    let join = std::thread::spawn(move || {
        let stop_cb = stop_thread.clone();
        HANDLER.with(|cell| {
            *cell.borrow_mut() = Some(Box::new(move || {
                if stop_cb.load(Ordering::Relaxed) {
                    return;
                }
                // Wait briefly for Windows mount assignment to settle.
                std::thread::sleep(Duration::from_millis(600));
                if !stop_cb.load(Ordering::Relaxed) {
                    on_change();
                }
            }));
        });

        let class_name = w!("PhotobogganMediaWatcher");
        let hinstance = unsafe { GetModuleHandleW(None) }.unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinstance.into(),
            lpszClassName: class_name,
            ..Default::default()
        };
        unsafe {
            let _ = RegisterClassW(&raw const wc);
        }
        // Must be a top-level (never-shown) window; HWND_MESSAGE windows do not receive WM_DEVICECHANGE broadcasts.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class_name,
                w!(""),
                WINDOW_STYLE(0),
                0,
                0,
                0,
                0,
                None,
                None,
                Some(hinstance.into()),
                None,
            )
        };
        let hwnd_val = hwnd.as_ref().map_or(0, |h| h.0 as usize);
        let _ = tx.send(hwnd_val);
        if hwnd_val == 0 {
            HANDLER.with(|cell| {
                *cell.borrow_mut() = None;
            });
            return;
        }
        let mut msg = MSG::default();
        unsafe {
            while GetMessageW(&raw mut msg, None, 0, 0).as_bool() {
                let _ = TranslateMessage(&raw const msg);
                DispatchMessageW(&raw const msg);
            }
        }
        HANDLER.with(|cell| {
            *cell.borrow_mut() = None;
        });
    });

    let hwnd_raw = rx.recv().unwrap_or(0);
    let mut guard = watcher_lock().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *guard = Some(WatcherState {
        stop,
        hwnd_raw,
        join: Some(join),
    });
}

#[cfg(not(windows))]
pub(crate) fn start_device_watcher(mut on_change: impl FnMut() + Send + 'static) {
    use std::ffi::CString;
    let mut pipe_fds = [-1i32; 2];
    if unsafe { libc::pipe(pipe_fds.as_mut_ptr()) } != 0 {
        return;
    }
    let read_fd = pipe_fds[0];
    let write_fd = pipe_fds[1];
    let stop = Arc::new(AtomicBool::new(false));
    let stop_thread = stop.clone();

    let join = std::thread::spawn(move || {
        let inotify_fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        if inotify_fd >= 0 {
            let user = std::env::var("USER").unwrap_or_default();
            let mut dirs = vec!["/media".to_string(), "/run/media".to_string()];
            if !user.is_empty() {
                dirs.push(format!("/media/{user}"));
                dirs.push(format!("/run/media/{user}"));
            }
            for dir in dirs {
                if Path::new(&dir).is_dir() {
                    if let Ok(c_dir) = CString::new(dir) {
                        unsafe {
                            libc::inotify_add_watch(
                                inotify_fd,
                                c_dir.as_ptr(),
                                libc::IN_CREATE | libc::IN_DELETE | libc::IN_MOVED_TO | libc::IN_MOVED_FROM,
                            );
                        }
                    }
                }
            }
            let mut fds = [
                libc::pollfd { fd: inotify_fd, events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: read_fd, events: libc::POLLIN, revents: 0 },
            ];
            let mut buf = [0u8; 4096];
            while !stop_thread.load(Ordering::Relaxed) {
                let rc = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
                if rc < 0 {
                    if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                        continue;
                    }
                    break;
                }
                if rc == 0 || stop_thread.load(Ordering::Relaxed) || (fds[1].revents & libc::POLLIN) != 0 {
                    break;
                }
                if (fds[0].revents & libc::POLLIN) != 0 {
                    while unsafe { libc::read(inotify_fd, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
                    std::thread::sleep(Duration::from_millis(600));
                    if !stop_thread.load(Ordering::Relaxed) {
                        on_change();
                    }
                }
            }
            unsafe {
                let _ = libc::close(inotify_fd);
            }
        }
        unsafe {
            let _ = libc::close(read_fd);
        }
    });

    let mut guard = watcher_lock().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    *guard = Some(WatcherState {
        stop,
        wake_write_fd: write_fd,
        join: Some(join),
    });
}
