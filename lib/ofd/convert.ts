import type { OFDDocument, OFDPage } from '@ofdrw/ofdrw-viewer-engine';
import { PDFDocument } from 'pdf-lib';
import { assetUrl } from '../pdf/asset-url';
import { yieldToBrowser } from '../pdf/office-common';
import { cancelled, type Progress } from '../pdf/tools';

const MB = 1024 * 1024;
export const OFD_MAX_FILE_MB = 80;
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_EDGE = 4096;
const MAX_PDF_IMAGE_BYTES = 160 * MB;
const POINTS_PER_MM = 72 / 25.4;

type OpenOptions = Awaited<ReturnType<typeof createOpenOptions>>;
export type OfdFile = {
  file: File;
  pages: number;
  sections: number[];
  preview: Blob;
  hasRenderingWarnings: boolean;
};

let fallbackFont: Promise<ArrayBuffer> | undefined;
function getFallbackFont() {
  fallbackFont ??= fetch(assetUrl('office-assets/NotoSansSC-Regular.ttf')).then(response => {
    if (!response.ok) throw new Error('中文字体加载失败，请刷新页面后重试。');
    return response.arrayBuffer();
  }).catch((error: unknown) => {
    fallbackFont = undefined;
    throw error;
  });
  return fallbackFont;
}

async function createOpenOptions(file: File, signal: AbortSignal) {
  const { OFDDocument } = await import('@ofdrw/ofdrw-viewer-engine');
  const font = await getFallbackFont();
  cancelled(signal);
  let hasRenderingWarnings = false;
  const renderingWarnings = /^(W_FONT_|W_GLYPH_|W_IMAGE_DECODE|W_JBIG2_|W_UNSUPPORTED_|W_SIGNATURE_|W_BAD_PATH|W_ANNOT_)/;
  return {
    open(documentIndex: number) {
      return OFDDocument.open({
        source: { kind: 'blob', blob: file },
        documentIndex,
        signal,
        limits: { maxPackageBytes: OFD_MAX_FILE_MB * MB, maxCanvasPixels: MAX_CANVAS_PIXELS, maxImagePixels: 32_000_000 },
        cache: { pageModels: 2, imageBytes: 24 * MB },
        defaultFonts: [{ data: font, family: 'Noto Sans SC' }],
        strictImageCtm: false,
        onWarning: warning => { if (renderingWarnings.test(warning.code)) hasRenderingWarnings = true; },
      });
    },
    hasRenderingWarnings: () => hasRenderingWarnings,
  };
}

async function openExportableDocument(options: OpenOptions, index: number, signal: AbortSignal) {
  const doc = await options.open(index);
  try {
    const permissions = await doc.getPermissions({ signal });
    if (!permissions.export) throw new Error('该 OFD 文档的权限设置禁止导出。');
    if (!doc.pageCount) throw new Error('OFD 文档没有可转换的页面。');
    return doc;
  } catch (error) {
    await doc.close();
    throw error;
  }
}

async function renderPage(page: OFDPage, preferredDpi: number, signal: AbortSignal) {
  const { width, height } = page.getSize();
  if (![width, height].every(value => Number.isFinite(value) && value > 0 && value * POINTS_PER_MM <= 14400)) {
    throw new Error('此 OFD 页面的尺寸超出 PDF 可导出的范围。');
  }
  const viewport = page.getViewport({ dpi: preferredDpi });
  const ratio = Math.min(1, (MAX_CANVAS_EDGE - 1) / Math.max(viewport.width, viewport.height),
    Math.sqrt((MAX_CANVAS_PIXELS * .99) / (viewport.width * viewport.height)));
  const image = await page.exportImage({ dpi: preferredDpi * ratio, format: 'jpeg', quality: .94, background: '#ffffff', signal });
  cancelled(signal);
  return { image: image.data, width: width * POINTS_PER_MM, height: height * POINTS_PER_MM };
}

export async function inspectOfd(file: File, progress: Progress, signal: AbortSignal): Promise<OfdFile> {
  if (!/\.ofd$/i.test(file.name)) throw new Error('请选择扩展名为 .ofd 的文件。');
  if (file.size > OFD_MAX_FILE_MB * MB) throw new Error(`单个 OFD 文件不能超过 ${OFD_MAX_FILE_MB} MB。`);
  const magic = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) throw new Error('无法读取此文件，请确认是完整的 OFD 文档。');

  progress('正在加载 OFD 转换组件…');
  const options = await createOpenOptions(file, signal);
  progress('正在读取 OFD 文档…');
  const sections: number[] = [];
  let documentCount = 1;
  let preview: Blob | undefined;
  for (let index = 0; index < documentCount; index++) {
    const doc = await openExportableDocument(options, index, signal);
    try {
      sections.push(doc.pageCount);
      if (index === 0) {
        const metadata = await doc.getMetadata({ signal });
        documentCount = Math.max(1, metadata.packageInfo?.docBodyCount ?? 1);
        if (documentCount > 32) throw new Error('这个 OFD 包含超过 32 个子文档，请拆分后转换。');
        progress('正在生成首页预览…');
        const rendered = await renderPage(await doc.getPage(0, { signal }), 110, signal);
        preview = new Blob([new Uint8Array(rendered.image)], { type: 'image/jpeg' });
      }
    } finally {
      await doc.close();
    }
  }
  return { file, pages: sections.reduce((sum, count) => sum + count, 0), sections, preview: preview!,
    hasRenderingWarnings: options.hasRenderingWarnings() };
}

export async function ofdToPdf(source: OfdFile, indices: number[], dpi: number, progress: Progress, signal: AbortSignal) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const options = await createOpenOptions(source.file, signal);
  let doc: OFDDocument | undefined;
  let currentSection = -1;
  let imageBytes = 0;
  try {
    for (const [position, index] of indices.entries()) {
      cancelled(signal);
      progress(`正在转换第 ${position+1} / ${indices.length} 页…`);
      await yieldToBrowser(signal);
      let pageIndex = index;
      const section = source.sections.findIndex(count => {
        if (pageIndex < count) return true;
        pageIndex -= count;
        return false;
      });
      if (section < 0) throw new Error('选定页码超出文档范围。');
      if (!doc || section !== currentSection) {
        await doc?.close();
        doc = await openExportableDocument(options, section, signal);
        currentSection = section;
      }
      const { image, width, height } = await renderPage(await doc.getPage(pageIndex, { signal }), dpi, signal);
      imageBytes += image.byteLength;
      if (imageBytes > MAX_PDF_IMAGE_BYTES) throw new Error('转换结果较大，请降低清晰度或分批转换。');
      const embedded = await pdf.embedJpg(image);
      pdf.addPage([width, height]).drawImage(embedded, { x: 0, y: 0, width, height });
      await pdf.flush();
    }
    progress('正在生成 PDF…');
    await yieldToBrowser(signal);
    const bytes = await pdf.save({ useObjectStreams: true });
    cancelled(signal);
    return { bytes, hasRenderingWarnings: options.hasRenderingWarnings() };
  } finally {
    await doc?.close();
  }
}

export function ofdErrorMessage(error: unknown) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'OFD_ENCRYPTED':
      return '该 OFD 已加密，请在原阅读器中解锁并另存后转换。';
    case 'OFD_LIMIT_EXCEEDED':
    case 'OFD_CANVAS_TOO_LARGE':
      return '文档资源超出浏览器处理上限，请试试较小的文件或分批转换。';
    case 'OFD_INVALID_PACKAGE':
    case 'OFD_XML_PARSE':
    case 'OFD_ENTRY_NOT_FOUND':
    case 'OFD_UNSUPPORTED_COMPRESSION':
      return '无法读取 OFD 文档，请检查文件是否完整，或用原阅读器另存后重试。';
    default:
      return error instanceof Error ? error.message : 'OFD 转换失败，请检查文件后重试。';
  }
}
