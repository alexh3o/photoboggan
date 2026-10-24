//! Prise en charge des vidéos (.mp4, .mov, .avi, .mkv) : détection et extraction ponctuelle d'une image fixe.
//!
//! Aucune lecture n'est faite dans l'application : une vidéo n'est lue que par le lecteur multimédia par défaut de l'OS
//! (commande `open_video_externally` de main.rs). Le seul traitement vidéo est l'extraction d'une image pour la miniature
//! et l'aperçu, mise en cache en JPEG comme celle des photos (voir thumbnails.rs).
//!
//! Sources de l'image, dans cet ordre :
//! - Windows : la vignette du Shell (IShellItemImageFactory), la même que celle de l'Explorateur. Elle utilise les codecs déjà
//!   installés sur la machine : rien à distribuer avec l'application.
//! - Repli, toutes plateformes : `ffmpeg` s'il est installé et accessible dans le PATH (jamais distribué avec l'application).
//! Si aucune des deux ne fournit d'image, la miniature reste absente : l'interface affiche alors la case avec son icône « Play ».

use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

/// Extensions de vidéos cataloguées (sans le point, en minuscules).
pub const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "avi", "mkv"];

pub fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| VIDEO_EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Image fixe d'une vidéo fournie par Windows (RGB, largeur, hauteur), au plus `max_side` px sur le grand côté
/// (Windows peut renvoyer plus grand : l'appelant réduit si besoin). Échoue si aucun codec n'est installé pour ce fichier.
#[cfg(windows)]
pub fn system_thumbnail(path: &Path, max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{
        DeleteObject, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS, HBITMAP, HGDIOBJ,
    };
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_THUMBNAILONLY};

    // Bitmap 32 bits (BGRA) du Shell -> RGB ; le bitmap est toujours libéré. L'alpha est ignoré (image de vidéo, donc opaque).
    unsafe fn bitmap_to_rgb(bitmap: HBITMAP) -> Result<(Vec<u8>, usize, usize), String> {
        let object = HGDIOBJ(bitmap.0);
        let mut info = BITMAP::default();
        let read = GetObjectW(object, std::mem::size_of::<BITMAP>() as i32, Some(&mut info as *mut BITMAP as *mut c_void));
        if read == 0 || info.bmWidth <= 0 || info.bmHeight == 0 {
            let _ = DeleteObject(object);
            return Err("Bitmap de miniature illisible".into());
        }
        let width = info.bmWidth;
        let height = info.bmHeight.abs();
        let mut header = BITMAPINFO::default();
        header.bmiHeader = BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height, // hauteur négative : lignes lues de haut en bas
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0, // BI_RGB
            ..Default::default()
        };
        let mut bgra = vec![0u8; width as usize * height as usize * 4];
        let device = GetDC(None);
        let lines = GetDIBits(device, bitmap, 0, height as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut header, DIB_RGB_COLORS);
        ReleaseDC(None, device);
        let _ = DeleteObject(object);
        if lines == 0 {
            return Err("Lecture des pixels de la miniature impossible".into());
        }
        let rgb: Vec<u8> = bgra.chunks_exact(4).flat_map(|pixel| [pixel[2], pixel[1], pixel[0]]).collect();
        Ok((rgb, width as usize, height as usize))
    }

    unsafe {
        // COM est initialisé par thread (les commandes asynchrones s'exécutent sur les threads du pool) ; on ne le libère que si c'est nous qui l'avons initialisé.
        let com_ready = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let result: Result<(Vec<u8>, usize, usize), String> = (|| {
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .map(|unit| if unit == u16::from(b'/') { u16::from(b'\\') } else { unit })
                .chain(std::iter::once(0))
                .collect();
            let factory: IShellItemImageFactory = SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None)
                .map_err(|error| format!("Fichier inconnu du Shell : {error}"))?;
            let side = max_side.clamp(64, 1024) as i32;
            // THUMBNAILONLY : si Windows n'a pas de vignette pour ce fichier (codec absent), on obtient une erreur et non une simple icône de fichier.
            let bitmap = factory
                .GetImage(SIZE { cx: side, cy: side }, SIIGBF_BIGGERSIZEOK | SIIGBF_THUMBNAILONLY)
                .map_err(|error| format!("Windows ne fournit pas de miniature pour ce fichier : {error}"))?;
            bitmap_to_rgb(bitmap)
        })();
        if com_ready {
            CoUninitialize();
        }
        result
    }
}

#[cfg(not(windows))]
pub fn system_thumbnail(_path: &Path, _max_side: usize) -> Result<(Vec<u8>, usize, usize), String> {
    Err("Pas de miniature vidéo fournie par le système sur cette plateforme".into())
}

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Image fixe d'une vidéo extraite par `ffmpeg` (JPEG pleine taille, réduit ensuite par l'appelant), si `ffmpeg` est installé.
/// Image prise à 1 s (évite le noir d'ouverture), au début si la vidéo est plus courte. Le processus est abandonné après 20 s.
pub fn ffmpeg_frame_jpeg(source: &Path) -> Result<Vec<u8>, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    let temp = std::env::temp_dir().join(format!("photoboggan-frame-{}-{}.jpg", std::process::id(), TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)));
    for seek in ["1", "0"] {
        let _ = fs::remove_file(&temp);
        let mut command = Command::new("ffmpeg");
        command
            .args(["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-ss", seek, "-i"])
            .arg(source)
            .args(["-frames:v", "1", "-q:v", "3"])
            .arg(&temp)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW : pas de fenêtre de console
        }
        let mut child = command.spawn().map_err(|_| "ffmpeg introuvable".to_string())?;
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() > Duration::from_secs(20) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break;
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => return Err(error.to_string()),
            }
        }
        if let Ok(bytes) = fs::read(&temp) {
            if bytes.len() > 4 {
                let _ = fs::remove_file(&temp);
                return Ok(bytes);
            }
        }
    }
    let _ = fs::remove_file(&temp);
    Err("ffmpeg n'a produit aucune image".into())
}
