// File kinds from the extension: RAW and video. Pure code: no state, no DOM. The extension lists themselves live in format-filters.js.
// Leaf module (imports nothing from main.js), so that modules such as photo-actions.js do not have to import main.js for these two tests.
import { RAW_EXTENSIONS, VIDEO_EXTENSIONS } from './format-filters.js';

// RAW extractor addition (list of extensions: format-filters.js)
export function isRawPath(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

// Videos are indexed like photos (list of extensions: format-filters.js, aligned with video.rs).
export function isVideoPath(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return VIDEO_EXTENSIONS.has(ext);
}
