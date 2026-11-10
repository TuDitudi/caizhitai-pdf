import { PDFDocument, degrees } from 'pdf-lib';
import { openPdf } from './engine';
import { cancelled, pageRange, safeStem, type Progress, type ToolFile } from './tools';

export type ImageFile = {
  id: string; name: string; file: File; width: number; height: number;
  kind: 'png' | 'jpeg' | 'other'; normalize: boolean; thumbnail: Blob; rotation: number;
};
export type ImagePdfOptions = { paper: 'image' | 'a4' | 'a4-landscape'; margin: number; limitSize: boolean };
export type PdfImageOptions = { range: string; format: 'png' | 'jpeg'; dpi: number; quality: number };
export type PageImage = { name: string; bytes: Uint8Array; page: number; width: number; height: number };
const MAX_PIXELS = 40_000_000;
const MAX_RENDER_PIXELS = 16_000_000;
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片生成失败，请降低清晰度后重试。')), type, quality));
}
function jpegNeedsNormalization(bytes: Uint8Array) {
  // PDF viewers ignore EXIF orientation. Normalize oriented camera photos first.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    let offset = 2;
    while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1], length = view.getUint16(offset + 2);
      if (marker === 0xda || marker === 0xd9 || length < 2) break;
      if (marker === 0xe1 && view.getUint32(offset + 4) === 0x45786966) {
        const base = offset + 10, little = view.getUint16(base) === 0x4949;
        const directory = base + view.getUint32(base + 4, little);
        const count = view.getUint16(directory, little);
        for (let n = 0; n < count; n++) {
          const at = directory + 2 + n * 12;
          if (view.getUint16(at, little) === 0x0112) return view.getUint16(at + 8, little) !== 1;
        }
      }
      offset += length + 2;
    }
  } catch { return true; }
  return false;
}
export async function readImageFile(file: File, signal?: AbortSignal): Promise<ImageFile> {
  if (file.size > 50 * 1024 * 1024) throw new Error(`“${file.name}”超过 50 MB，请先缩小图片。`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  cancelled(signal);
  const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
  const jpeg = bytes[0] === 255 && bytes[1] === 216;
  const gif = bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70;
  const bmp = bytes[0] === 66 && bytes[1] === 77;
  const webp = bytes[0] === 82 && bytes[1] === 73 && bytes[8] === 87 && bytes[9] === 69;
  if (!png && !jpeg && !gif && !bmp && !webp) throw new Error(`“${file.name}”不是支持的图片。请选择 PNG、JPG、JPEG、WebP、BMP 或 GIF。`);
  let bitmap: ImageBitmap;
  try { bitmap = await createImageBitmap(file); }
  catch { throw new Error(`无法读取“${file.name}”，请确认图片完整且格式可由浏览器打开。`); }
  const canvas = document.createElement('canvas');
  try {
    cancelled(signal);
    if (!bitmap.width || !bitmap.height || bitmap.width * bitmap.height > MAX_PIXELS || Math.max(bitmap.width, bitmap.height) > 24000) {
      throw new Error(`“${file.name}”尺寸过大，请先缩小到 4000 万像素以内，最长边不超过 24000 像素。`);
    }
    const scale = Math.min(1, 300 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return { id: crypto.randomUUID(), name: file.name, file, width: bitmap.width, height: bitmap.height,
      kind: png ? 'png' : jpeg ? 'jpeg' : 'other', normalize: jpeg && jpegNeedsNormalization(bytes),
      thumbnail: await canvasBlob(canvas, 'image/png'), rotation: 0 };
  } finally { bitmap.close(); canvas.width = canvas.height = 1; }
}
export function imagePageSize(image: ImageFile, options: ImagePdfOptions): [number, number] {
  if (options.paper === 'a4') return [595.28, 841.89];
  if (options.paper === 'a4-landscape') return [841.89, 595.28];
  const w = image.rotation % 180 ? image.height : image.width;
  const h = image.rotation % 180 ? image.width : image.height;
  const scale = Math.min(.75, 14000 / Math.max(w, h));
  return [Math.max(1, w * scale), Math.max(1, h * scale)];
}
async function encodeImage(image: ImageFile, compression?: { scale: number; quality: number }) {
  if (!compression && image.kind !== 'other' && !image.normalize) {
    return { bytes: await image.file.arrayBuffer(), png: image.kind === 'png' };
  }
  const bitmap = await createImageBitmap(image.file), canvas = document.createElement('canvas');
  try {
    canvas.width = Math.max(1, Math.round(bitmap.width * (compression?.scale ?? 1)));
    canvas.height = Math.max(1, Math.round(bitmap.height * (compression?.scale ?? 1)));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前设备无法创建图片，请减少图片尺寸后重试。');
    const usePng = !compression && image.kind !== 'jpeg';
    if (!usePng) { context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvasBlob(canvas, usePng ? 'image/png' : 'image/jpeg', compression?.quality ?? .96);
    return { bytes: await blob.arrayBuffer(), png: usePng };
  } finally { bitmap.close(); canvas.width = canvas.height = 1; }
}
export async function imagesToPdf(images: ImageFile[], options: ImagePdfOptions, progress: Progress, signal?: AbortSignal) {
  if (!images.length || images.length > 100) throw new Error('请选择 1 到 100 张图片。');
  if (!Number.isFinite(options.margin) || options.margin < 0 || options.margin > 40) throw new Error('留白应在 0 到 40 毫米之间。');
  const limit = images.reduce((total, image) => total + image.file.size, 0);
  const attempts = [undefined, { scale: 1, quality: .85 }, { scale: 1, quality: .65 }, { scale: .75, quality: .65 }, { scale: .5, quality: .55 }];
  for (const compression of attempts) {
    cancelled(signal);
    const pdf = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < images.length; i++) {
      cancelled(signal); progress(`${compression ? '正在压缩图片并生成 PDF' : '正在生成 PDF'} · 第 ${i + 1} / ${images.length} 页…`);
      const source = images[i], encoded = await encodeImage(source, compression);
      cancelled(signal);
      const embedded = encoded.png ? await pdf.embedPng(encoded.bytes) : await pdf.embedJpg(encoded.bytes);
      const [width, height] = imagePageSize(source, options);
      const margin = options.paper === 'image' ? 0 : options.margin * 72 / 25.4;
      const rotatedWidth = source.rotation % 180 ? source.height : source.width;
      const rotatedHeight = source.rotation % 180 ? source.width : source.height;
      const scale = Math.min((width - 2 * margin) / rotatedWidth, (height - 2 * margin) / rotatedHeight);
      const iw = source.width * scale, ih = source.height * scale, angle = -source.rotation * Math.PI / 180;
      pdf.addPage([width, height]).drawImage(embedded, {
        x: width / 2 - (iw * Math.cos(angle) - ih * Math.sin(angle)) / 2,
        y: height / 2 - (iw * Math.sin(angle) + ih * Math.cos(angle)) / 2,
        width: iw, height: ih, rotate: degrees(-source.rotation),
      });
      // Flush each image so a large batch does not retain all decoded PNG pixels.
      await pdf.flush(); await tick();
    }
    const bytes = await pdf.save({ useObjectStreams: true, addDefaultPage: false });
    cancelled(signal);
    if (!options.limitSize || bytes.byteLength <= limit) return { bytes, compressed: !!compression };
  }
  throw new Error('无法在图片合计大小内生成清晰的 PDF，已停止下载。可减少图片，或取消体积限制后保留画质导出。');
}
export async function pdfToImages(file: ToolFile, options: PdfImageOptions, progress: Progress, signal?: AbortSignal) {
  const indices = pageRange(options.range, file.pages);
  if (indices.length > 200) throw new Error('每次最多转换 200 页，请分批选择页码。');
  if (![72, 150, 300].includes(options.dpi) || options.quality < .4 || options.quality > 1) throw new Error('图片设置无效。');
  cancelled(signal);
  const doc = await openPdf(file.bytes.slice()), results: PageImage[] = [];
  let totalBytes = 0, reduced = false;
  try {
    for (let i = 0; i < indices.length; i++) {
      cancelled(signal); const n = indices[i] + 1;
      progress(`正在生成第 ${n} 页图片（${i + 1} / ${indices.length}）…`);
      const page = await doc.getPage(n), base = page.getViewport({ scale: 1 });
      const scale = Math.min(options.dpi / 72, Math.sqrt((MAX_RENDER_PIXELS - 16000) / (base.width * base.height)), 8191 / Math.max(base.width, base.height));
      if (scale < options.dpi / 72 - .001) reduced = true;
      const viewport = page.getViewport({ scale }), canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.ceil(viewport.width)); canvas.height = Math.max(1, Math.ceil(viewport.height));
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('当前设备无法生成页面图片，请选择较低清晰度。');
        const render = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
        const cancelRender = () => render.cancel(); signal?.addEventListener('abort', cancelRender, { once: true });
        try { cancelled(signal); await render.promise; }
        finally { signal?.removeEventListener('abort', cancelRender); }
        cancelled(signal);
        const blob = await canvasBlob(canvas, options.format === 'png' ? 'image/png' : 'image/jpeg', options.quality);
        cancelled(signal); totalBytes += blob.size;
        if (totalBytes > 200 * 1024 * 1024) throw new Error('图片合计超过 200 MB，请减少页数、降低清晰度或改用 JPG。');
        results.push({ name: `${safeStem(file.name)}-第${String(n).padStart(3, '0')}页.${options.format === 'png' ? 'png' : 'jpg'}`,
          bytes: new Uint8Array(await blob.arrayBuffer()), page: n, width: canvas.width, height: canvas.height });
      } finally { canvas.width = canvas.height = 1; page.cleanup(); }
      await tick();
    }
    cancelled(signal); return { images: results, reduced };
  } catch (error) { cancelled(signal); throw error; }
  finally { await doc.destroy(); }
}
