import { PDFDocument, degrees, concatTransformationMatrix, pushGraphicsState, popGraphicsState, PDFName, PDFDict } from 'pdf-lib';
import { layout, type Edit } from './geometry';

export type ExportOptions = { source: Uint8Array; maxBytes: number; allowCompression: boolean };
export type ExportResult = { bytes: Uint8Array; method: 'original' | 'compressed'; capped: boolean };
export function fileSize(n: number) { return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)} MB` : `${(n / 1000).toFixed(1)} KB`; }
export function byteLimit(sourceSize: number) {
  if (!Number.isFinite(sourceSize) || sourceSize < 1) throw new Error('原文件大小无效，请重新导入。');
  return Math.floor(sourceSize);
}
export function checkSize(bytes: Uint8Array, limit: number) {
  if (bytes.byteLength > limit) throw new Error(`导出文件为 ${fileSize(bytes.byteLength)}，超出上限 ${(bytes.byteLength-limit).toLocaleString()} 字节，已停止下载。请允许压缩或减少导出页数。`);
}
const pureCrop = (e: Edit) => e.paper === 'crop' && e.margin === 0 && e.scale === 100 && e.offsetX === 0 && e.offsetY === 0;
const unchanged = (e: Edit, i: number) => pureCrop(e) && e.source === i + 1 && e.rotation === 0 && e.crop.x === 0 && e.crop.y === 0 && e.crop.w === 1 && e.crop.h === 1;

/** Reuse original image streams. CropBox and Form clipping are visual cropping, not redaction. */
export async function originalPdf(doc: any, edits: Edit[], source: Uint8Array, progress: (s: string) => void) {
  if (edits.length === doc.numPages && edits.every(unchanged)) return source.slice();
  const src = await PDFDocument.load(source, { updateMetadata: false });
  const out = await PDFDocument.create({ updateMetadata: false });
  // Copy together to preserve shared fonts/images without per-page duplication.
  const pages = await out.copyPages(src, edits.map(e => e.source - 1));
  for (let i = 0; i < edits.length; i++) {
    progress(`保留原始内容 · 第 ${i + 1} / ${edits.length} 页…`);
    const e = edits[i], page = pages[i], proxy = await doc.getPage(e.source);
    const rotation = (proxy.rotate + e.rotation) % 360;
    const viewport = proxy.getViewport({ scale: 1, rotation });
    const sx = viewport.width * e.crop.x, sy = viewport.height * e.crop.y;
    const sw = viewport.width * e.crop.w, sh = viewport.height * e.crop.h;
    const corners = [[sx, sy], [sx + sw, sy], [sx, sy + sh], [sx + sw, sy + sh]].map(([x, y]) => viewport.convertToPdfPoint(x, y));
    const left = Math.min(...corners.map(p => p[0])), right = Math.max(...corners.map(p => p[0]));
    const bottom = Math.min(...corners.map(p => p[1])), top = Math.max(...corners.map(p => p[1]));
    if (pureCrop(e)) {
      page.setMediaBox(left, bottom, right - left, top - bottom);
      page.setCropBox(left, bottom, right - left, top - bottom);
      page.setTrimBox(left, bottom, right - left, top - bottom);
      page.setBleedBox(left, bottom, right - left, top - bottom);
      page.setArtBox(left, bottom, right - left, top - bottom);
      page.setRotation(degrees(rotation));
      out.addPage(page);
    } else {
      // Convert source coordinates through PDF.js's viewport matrix; this handles
      // rotated pages, nonzero CropBox origins, and UserUnit without guessing axes.
      if (!page.node.Contents()) { out.addPage([layout(e).w, layout(e).h]); continue; }
      const embedded = await out.embedPage(page, {left, bottom, right, top}, [1, 0, 0, 1, 0, 0]);
      const l = layout(e), k = l.iw / sw, v = viewport.transform;
      const target = out.addPage([l.w, l.h]);
      const group = page.node.lookupMaybe(PDFName.of('Group'), PDFDict);
      // Transparency groups are not used by ordinary scans; raster fallback is
      // preferable to silently changing their compositing in native placement.
      if (group) throw new Error('该页面包含透明分组，需要使用压缩图像导出。');
      target.pushOperators(pushGraphicsState(), concatTransformationMatrix(k*v[0], -k*v[1], k*v[2], -k*v[3], l.x+k*(v[4]-sx), l.h-l.y-k*(v[5]-sy)));
      target.drawPage(embedded, {x:0,y:0,xScale:1,yScale:1});
      target.pushOperators(popGraphicsState());
      // The Form already owns the content/resources. Drop the unused copied page
      // dictionary so rearranging a page does not retain a duplicate page object.
      out.context.delete(page.ref);
    }
  }
  return out.save({useObjectStreams:true, addDefaultPage:false, updateFieldAppearances:false});
}
