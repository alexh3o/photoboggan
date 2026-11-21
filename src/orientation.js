// Orientation helpers of the lossless rotation (orientation.rs). Pure code: no state, no DOM.
//
// The webview turns an original it shows by its EXIF tag only. When the orientation that wins is an XMP
// one (internal writer, sidecar of a PNG…), `photo.view_fix` (1 to 8, same values as the EXIF tag) is what remains to apply on top.
// Generated previews (RAW, HEIC, videos) and the thumbnails are already turned by the backend: their view_fix is 1.

// Matrix (CSS / canvas order a, b, c, d, e, f) of an orientation for a box of `width` × `height` px, origin at its top-left corner.
export function orientationMatrix(orientation, width, height) {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0];
    case 3: return [-1, 0, 0, -1, width, height];
    case 4: return [1, 0, 0, -1, 0, height];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, height, 0];
    case 7: return [0, -1, -1, 0, height, width];
    case 8: return [0, -1, 1, 0, 0, width];
    default: return null;
  }
}

// Orientations that exchange width and height (quarter turns).
export const swapsSides = orientation => orientation >= 5 && orientation <= 8;
