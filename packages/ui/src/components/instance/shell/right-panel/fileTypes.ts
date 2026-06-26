// Shared file type detection utilities for the right panel (Files + Git Changes).
//
// Mirrors the existing `isMarkdownPath` pattern in `tabs/FilesTab.tsx`. Used by
// the Files panel, Git Changes tab, and the `<ImagePreview>` component to gate
// inline binary previews.

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|ico)$/i

export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
}

// 10 MB cap on source file size (NOT on base64 string length).
export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024

export function isImagePath(path: string | null | undefined): boolean {
  if (!path) return false
  return IMAGE_EXTENSIONS.test(path)
}

export function detectImageMime(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  const dotIndex = path.lastIndexOf(".")
  if (dotIndex < 0) return undefined
  return IMAGE_MIME[path.slice(dotIndex).toLowerCase()]
}

// Approximate binary size from a base64 string. Base64 inflates by 4/3, so
// binary ~= base64.length * 3 / 4 (minus a small padding overhead). This is
// good enough for the 10 MB cap comparison — we only need a rough order of
// magnitude, not exact bytes.
export function approximateBinarySizeFromBase64(base64: string): number {
  if (!base64) return 0
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}
