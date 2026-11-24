/**
 * Checks uploaded files by their actual bytes, not by the file name or the
 * browser's claimed type (both are easy to fake).
 */

export const MAX_LOGO_BYTES = 10 * 1024 * 1024;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MIN_LOGO_WIDTH = 1000;

export type UploadKind = "logo" | "asset";

export interface FileCheckOk {
  ok: true;
  contentType: string;
  ext: string;
  note?: string;
}
export interface FileCheckFail {
  ok: false;
  error: string;
}
export type FileCheck = FileCheckOk | FileCheckFail;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  return sig.every((b, i) => bytes[i] === b);
}

function u32(bytes: Uint8Array, off: number): number {
  return ((bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3]) >>> 0;
}

export interface PngInfo {
  width: number;
  height: number;
  hasAlpha: boolean;
}

/** Reads width/height from the IHDR chunk and checks for any transparency. */
export function readPngInfo(bytes: Uint8Array): PngInfo | null {
  if (bytes.length < 33 || !startsWith(bytes, PNG_SIG)) return null;
  const width = u32(bytes, 16);
  const height = u32(bytes, 20);
  const colorType = bytes[25];
  // Color types 4 (gray+alpha) and 6 (RGBA) carry an alpha channel.
  let hasAlpha = colorType === 4 || colorType === 6;
  // Other types can still be transparent through a tRNS chunk (before IDAT).
  let off = 8;
  while (!hasAlpha && off + 8 <= bytes.length) {
    const len = u32(bytes, off);
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    if (type === "tRNS") hasAlpha = true;
    if (type === "IDAT" || type === "IEND") break;
    off += 12 + len;
  }
  return { width, height, hasAlpha };
}

const SVG_DANGER = /<script|<foreignObject|\son[a-z]+\s*=|javascript:|<iframe|<embed|<object/i;

function checkSvg(bytes: Uint8Array): FileCheck {
  const text = new TextDecoder().decode(bytes);
  if (!/<svg[\s>]/i.test(text.slice(0, 4096))) return { ok: false, error: "That file isn't a real SVG." };
  if (SVG_DANGER.test(text)) {
    return { ok: false, error: "That SVG has scripts or links in it. Export a plain SVG from your design app and try again." };
  }
  return { ok: true, contentType: "image/svg+xml", ext: "svg" };
}

function isEps(bytes: Uint8Array): boolean {
  if (startsWith(bytes, [0xc5, 0xd0, 0xd3, 0xc6])) return true; // DOS EPS binary header
  return new TextDecoder().decode(bytes.slice(0, 4)) === "%!PS";
}

export function checkUpload(kind: UploadKind, bytes: Uint8Array): FileCheck {
  const max = kind === "logo" ? MAX_LOGO_BYTES : MAX_ASSET_BYTES;
  if (bytes.length === 0) return { ok: false, error: "That file is empty." };
  if (bytes.length > max) return { ok: false, error: `That file is over ${Math.round(max / 1024 / 1024)} MB.` };

  if (startsWith(bytes, PNG_SIG)) {
    const info = readPngInfo(bytes);
    if (!info) return { ok: false, error: "That PNG looks damaged." };
    if (kind === "logo") {
      if (info.width < MIN_LOGO_WIDTH) {
        return { ok: false, error: `Your PNG logo is ${info.width}px wide. It needs to be at least ${MIN_LOGO_WIDTH}px.` };
      }
      if (!info.hasAlpha) {
        return { ok: false, error: "Your PNG logo has a solid background. Export it with a transparent background." };
      }
    }
    return { ok: true, contentType: "image/png", ext: "png", note: `${info.width}x${info.height}` };
  }
  if (isEps(bytes)) return { ok: true, contentType: "application/postscript", ext: "eps" };

  const head = new TextDecoder().decode(bytes.slice(0, 512)).trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || head.startsWith("<!--") || head.startsWith("<!DOCTYPE svg")) {
    return checkSvg(bytes);
  }

  if (kind === "asset") {
    if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { ok: true, contentType: "image/jpeg", ext: "jpg" };
    if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { ok: true, contentType: "application/zip", ext: "zip" };
    return { ok: false, error: "Brand files can be SVG, EPS, PNG, JPG, or ZIP." };
  }
  return { ok: false, error: "Logos must be SVG, EPS, or a transparent PNG at least 1000px wide." };
}
