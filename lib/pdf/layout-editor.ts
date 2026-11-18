import { PDFDocument, degrees, rgb } from 'pdf-lib';
import { openPdf, pdfEngine } from './engine';
import { assetUrl } from './asset-url';
import { canvasBlob, embedOfficeFont, yieldToBrowser } from './office-common';
import { cancelled, pageRange, type Progress, type ToolFile } from './tools';

export type EditableText = {
  id: string;
  original: string;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  size: number;
  angle: number;
  color: string;
  background: string;
  source: 'pdf' | 'ocr';
};
export type EditablePage = {
  page: number;
  width: number;
  height: number;
  image: Blob;
  background?: Blob;
  blocks: EditableText[];
  warning?: string;
};

async function imageCanvas(blob: Blob) {
  const image = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  canvas.getContext('2d')!.drawImage(image, 0, 0);
  image.close();
  return canvas;
}

function paperColor(canvas: HTMLCanvasElement, x: number, y: number, w: number, h: number) {
  const context = canvas.getContext('2d')!;
  const colors = new Map<string, number>();
  for (const [px, py] of [[x - 2, y], [x + w + 2, y], [x, y - 2], [x + w, y + h + 2]]) {
    const point = context.getImageData(Math.max(0, Math.min(canvas.width - 1, Math.round(px))), Math.max(0, Math.min(canvas.height - 1, Math.round(py))), 1, 1).data;
    const color = `#${[...point.slice(0, 3)].map(n => n.toString(16).padStart(2, '0')).join('')}`;
    colors.set(color, (colors.get(color) || 0) + 1);
  }
  return [...colors].sort((a, b) => b[1] - a[1])[0][0];
}

function visibleTextColor(original: HTMLCanvasElement, background: HTMLCanvasElement, block: EditableText, scale: number) {
  const c = Math.cos(block.angle), s = Math.sin(block.angle);
  const corners = [[0, 0], [block.width, 0], [0, block.height], [block.width, block.height]];
  const xs = corners.map(([x, y]) => (block.x + x * c - y * s) * scale);
  const ys = corners.map(([x, y]) => (block.y + x * s + y * c) * scale);
  const x = Math.max(0, Math.floor(Math.min(...xs))), y = Math.max(0, Math.floor(Math.min(...ys)));
  const width = Math.min(original.width - x, Math.ceil(Math.max(...xs)) - x);
  const height = Math.min(original.height - y, Math.ceil(Math.max(...ys)) - y);
  if (width <= 0 || height <= 0) return undefined;
  const a = original.getContext('2d')!.getImageData(x, y, width, height).data;
  const b = background.getContext('2d')!.getImageData(x, y, width, height).data;
  let strongest = 30, color: string | undefined;
  for (let i = 0; i < a.length; i += 4) {
    const difference = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (difference > strongest) {
      strongest = difference;
      color = `#${[a[i], a[i + 1], a[i + 2]].map(n => n.toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return color;
}

export async function recognizeLayout(file: ToolFile, range: string, language: 'chi_sim+eng' | 'eng', progress: Progress, signal: AbortSignal): Promise<EditablePage[]> {
  const indices = pageRange(range, file.pages);
  const pdf = await openPdf(file.bytes.slice());
  const engine = await pdfEngine();
  let worker: Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>> | undefined;
  const stop = () => { void worker?.terminate(); };
  signal.addEventListener('abort', stop);
  const pages: EditablePage[] = [];
  try {
    for (const index of indices) {
      cancelled(signal);
      progress(`正在识别第 ${index + 1} 页（${pages.length + 1} / ${indices.length}）`);
      const page = await pdf.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2400 / Math.max(base.width, base.height), 200 / 72);
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport, background: '#ffffff' }).promise;
        cancelled(signal);
        const result: EditablePage = { page: index + 1, width: base.width, height: base.height, image: await canvasBlob(canvas), blocks: [] };
        const content = await page.getTextContent();
        for (const item of content.items) {
          if (!('str' in item) || !item.str.trim()) continue;
          const transform = engine.Util.transform(base.transform, item.transform);
          const size = Math.hypot(transform[2], transform[3]);
          const angle = Math.atan2(transform[1], transform[0]);
          const ascent = content.styles[item.fontName]?.ascent ?? 0.85;
          result.blocks.push({ id: `${index}-${result.blocks.length}`, original: item.str, text: item.str,
            x: transform[4] + Math.sin(angle) * size * ascent,
            y: transform[5] - Math.cos(angle) * size * ascent,
            width: Math.max(item.width, size * 0.3), height: size * 1.15, size, angle,
            color: '#202020', background: '#ffffff', source: 'pdf' });
        }
        if (result.blocks.length) {
          // Render graphics without text. Modified text regions can recover the
          // actual page background instead of covering table lines with white.
          const operators = await page.getOperatorList();
          const textOps = new Set([engine.OPS.showText, engine.OPS.showSpacedText, engine.OPS.nextLineShowText, engine.OPS.nextLineSetSpacingShowText]);
          const background = document.createElement('canvas');
          background.width = canvas.width;
          background.height = canvas.height;
          try {
            await page.render({ canvas: background, canvasContext: background.getContext('2d')!, viewport, background: '#ffffff', operationsFilter: i => !textOps.has(operators.fnArray[i]) }).promise;
            // Scanned PDFs may already contain an invisible OCR text layer.
            // Its visible glyphs belong to the image and need the scan edit path.
            for (const block of result.blocks) {
              const color = visibleTextColor(canvas, background, block, scale);
              if (color) block.color = color;
              else {
                block.source = 'ocr';
                block.background = paperColor(canvas, block.x * scale, block.y * scale, block.width * scale, block.height * scale);
              }
            }
            result.background = await canvasBlob(background);
          } finally { background.width = background.height = 1; }
        } else {
          try {
            if (!worker) {
              progress('正在加载扫描文字识别组件');
              const { createWorker } = await import('tesseract.js');
              worker = await createWorker(language, 1, { workerPath: assetUrl('ocr/worker.min.js'), corePath: assetUrl('ocr/core'), langPath: assetUrl('ocr/lang'), gzip: false, cacheMethod: 'none', workerBlobURL: false });
              cancelled(signal);
            }
            const recognized = await worker.recognize(canvas, {}, { blocks: true, text: true });
            for (const block of recognized.data.blocks || []) for (const paragraph of block.paragraphs) for (const line of paragraph.lines) {
              const text = line.text.trim();
              if (!text) continue;
              const { x0, y0, x1, y1 } = line.bbox;
              result.blocks.push({ id: `${index}-${result.blocks.length}`, original: text, text,
                x: x0 / scale, y: y0 / scale, width: (x1 - x0) / scale, height: (y1 - y0) / scale,
                size: (y1 - y0) / scale, angle: 0, color: '#202020', background: paperColor(canvas, x0, y0, x1 - x0, y1 - y0), source: 'ocr' });
            }
            if (!result.blocks.length) result.warning = '这页未识别到文字，原页面已保留。';
          } catch (error) {
            cancelled(signal);
            result.warning = '这页文字识别失败，原页面已保留，可重新识别。';
          }
        }
        pages.push(result);
      } finally { canvas.width = canvas.height = 1; }
      await yieldToBrowser(signal);
    }
    return pages;
  } finally {
    signal.removeEventListener('abort', stop);
    await worker?.terminate().catch(() => {});
    await pdf.destroy();
  }
}

export function changedText(block: EditableText) {
  return block.text !== block.original;
}

// Paint only edited text regions. Other pixels keep their original appearance.
export async function editedBackground(page: EditablePage) {
  const canvas = await imageCanvas(page.image);
  const context = canvas.getContext('2d')!;
  const scale = canvas.width / page.width;
  const background = page.background ? await createImageBitmap(page.background) : undefined;
  try {
    for (const block of page.blocks.filter(changedText)) {
      context.save();
      context.scale(scale, scale);
      context.translate(block.x, block.y);
      context.rotate(block.angle);
      context.beginPath();
      context.rect(-0.6, -0.6, block.width + 1.2, block.height + 1.2);
      context.clip();
      context.rotate(-block.angle);
      context.translate(-block.x, -block.y);
      if (background && block.source === 'pdf') context.drawImage(background, 0, 0, page.width, page.height);
      else {
        context.fillStyle = block.background;
        context.fillRect(0, 0, page.width, page.height);
      }
      context.restore();
    }
    return await canvasBlob(canvas);
  } finally { background?.close(); canvas.width = canvas.height = 1; }
}

export async function exportEditedPdf(file: ToolFile, pages: EditablePage[], progress: Progress, signal: AbortSignal) {
  const original = await PDFDocument.load(file.bytes.slice());
  const output = await PDFDocument.create();
  const changed = pages.flatMap(p => p.blocks.filter(changedText));
  const font = changed.some(b => b.text) ? await embedOfficeFont(output, changed.map(b => b.text).join('')) : undefined;
  for (const page of pages) {
    cancelled(signal);
    progress(`正在导出第 ${page.page} 页`);
    const edits = page.blocks.filter(changedText);
    if (!edits.length) {
      const [copy] = await output.copyPages(original, [page.page - 1]);
      output.addPage(copy);
    } else {
      const image = await output.embedPng(await (await editedBackground(page)).arrayBuffer());
      const target = output.addPage([page.width, page.height]);
      target.drawImage(image, { x: 0, y: 0, width: page.width, height: page.height });
      for (const block of edits) {
        if (!block.text || !font) continue;
        const lines = block.text.split('\n');
        const size = Math.max(1, Math.min(block.size, block.height / (lines.length * 1.15), ...lines.filter(Boolean).map(line => block.width / font.widthOfTextAtSize(line, 1))));
        const color = block.color.match(/\w\w/g)!.map(n => parseInt(n, 16) / 255);
        lines.forEach((line, index) => {
          const offset = size * (0.85 + index * 1.15);
          target.drawText(line, { x: block.x - Math.sin(block.angle) * offset, y: page.height - block.y - Math.cos(block.angle) * offset,
            size, font, color: rgb(color[0], color[1], color[2]), rotate: degrees(-block.angle * 180 / Math.PI) });
        });
      }
    }
    await yieldToBrowser(signal);
  }
  cancelled(signal);
  return output.save();
}
