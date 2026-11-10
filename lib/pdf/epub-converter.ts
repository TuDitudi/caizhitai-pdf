import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { Worker as OcrWorker, LoggerMessage } from 'tesseract.js';
import { pdfEngine } from './engine';
import { textLines, type WordOptions, type WordPage } from './word';
import { cancelled, pageRange, type Progress, type ToolFile } from './tools';

// Use the same parser for EPUB inspection and rendering. Other parsers can drop
// damaged pages during inspection, shifting the range and silently omitting pages.
async function openEpubPdf(bytes: Uint8Array) {
  const engine = await pdfEngine();
  return engine.getDocument({ data: bytes, cMapUrl: '/pdf-assets/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdf-assets/standard_fonts/', wasmUrl: '/pdf-assets/wasm/',
    isEvalSupported: false, stopAtErrors: true }).promise;
}
export async function inspectEpubFile(bytes: Uint8Array, name: string): Promise<ToolFile> {
  if (!name.toLowerCase().endsWith('.pdf')) throw new Error('请选择 PDF 文件。');
  if (bytes.byteLength > 200 * 1024 * 1024) throw new Error('单个文件不能超过 200 MB。');
  const doc = await openEpubPdf(bytes.slice());
  try { return { id: crypto.randomUUID(), name, bytes, pages: doc.numPages }; }
  finally { await doc.destroy(); }
}
async function unavailablePage(page: number, width: number, height: number): Promise<WordPage> {
  const warning = `原 PDF 第 ${page} 页的数据缺失或损坏，无法还原。`;
  const canvas = document.createElement('canvas');canvas.width = 1000;canvas.height = 1400;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#fff';context.fillRect(0, 0, 1000, 1400);context.fillStyle = '#333';
  context.textAlign = 'center';context.font = 'bold 42px sans-serif';context.fillText(`原第 ${page} 页无法读取`, 500, 580);
  context.font = '28px sans-serif';context.fillText('原 PDF 的本页数据缺失或损坏。', 500, 670);
  context.fillText('请换用完整的原文件后重新转换。', 500, 720);
  const blob = await jpeg(canvas);canvas.width = canvas.height = 1;
  return { page, width, height, method: 'image', text: '', image: new Uint8Array(await blob.arrayBuffer()), warning };
}

const CACHE_LIMIT = 32 * 1024 * 1024;
const WORKER_IDLE_MS = 60_000;
const MODEL_CACHE = 'caizhitai-ocr-best-int-v1';
type CacheEntry = { page: WordPage; bytes: number };
type WorkerSlot = { pending: Promise<OcrWorker>; worker?: OcrWorker; notify: (message: LoggerMessage) => void };
export type EpubPageOptions = Omit<WordOptions, 'mode'> & { mode: 'auto' | 'editable' | 'image' };
export type EpubConversion = { pages: WordPage[]; reused: number; elapsedMs: number };

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => reject(new Error('操作已取消。已完成的页面可在再次转换时继续使用。'));
    signal.addEventListener('abort', stop, { once: true });
    promise.then(value => { signal.removeEventListener('abort', stop); if (signal.aborted) stop(); else resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
    if (signal.aborted) stop();
  });
}
function readableText(text: string) {
  const compact = text.replace(/\s/g, '');
  if (!compact) return false;
  const invalid = compact.match(/[\u0000-\u001f\u007f-\u009f\ue000-\uf8ff\ufffd]/g)?.length || 0;
  return invalid / compact.length < .1;
}
function concurrency() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  // Keep phones and devices with unknown memory on one OCR worker.
  return (navigator.hardwareConcurrency || 1) >= 4 && (memory || 0) >= 4 ? 2 : 1;
}
async function render(page: PDFPageProxy, target: number, signal: AbortSignal) {
  cancelled(signal);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: target / Math.max(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前设备无法绘制页面，请减少本次转换页数。');
  const task = page.render({ canvas, canvasContext: context, viewport, background: '#ffffff' });
  const stop = () => task.cancel(); signal.addEventListener('abort', stop, { once: true });
  try { cancelled(signal); await task.promise; cancelled(signal); return canvas; }
  catch (error) { canvas.width = canvas.height = 1; cancelled(signal); throw error; }
  finally { signal.removeEventListener('abort', stop); }
}
function jpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('页面图片生成失败。')), 'image/jpeg', .86));
}

/** One uploaded PDF, with bounded in-memory results. Only public OCR models use IndexedDB. */
export class EpubConverter {
  private cache = new Map<string, CacheEntry>();
  private autoMethods = new Map<number, 'text' | 'image'>();
  // Explicit user edits must survive eviction of regenerable page/image results.
  private corrections = new Map<string, WordPage>();
  private cacheBytes = 0;
  private slots: WorkerSlot[] = [];
  private workerLanguage = '';
  private generation = 0;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private running?: AbortController;

  constructor(private file: ToolFile) {}

  private key(page: number, method: WordPage['method'], language: string) {
    return `${page}:${method}${method === 'ocr' ? `:${language}` : ''}`;
  }
  private get(key: string) {
    const correction = this.corrections.get(key);
    if (correction) return { ...correction };
    const value = this.cache.get(key);
    if (!value) return undefined;
    this.cache.delete(key); this.cache.set(key, value);
    return { ...value.page };
  }
  private put(key: string, page: WordPage) {
    const old = this.cache.get(key);
    if (old) { this.cacheBytes -= old.bytes; this.cache.delete(key); }
    const bytes = page.text.length * 2 + (page.image?.byteLength || 0) + 192;
    if (bytes > CACHE_LIMIT) return;
    while (this.cacheBytes + bytes > CACHE_LIMIT && this.cache.size) {
      const oldest = this.cache.keys().next().value!;
      this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
    }
    this.cache.set(key, { page: { ...page }, bytes }); this.cacheBytes += bytes;
  }
  private cached(page: number, options: EpubPageOptions) {
    if (options.mode === 'auto') {
      const method = this.autoMethods.get(page);
      return method ? this.get(this.key(page, method, options.language)) : undefined;
    }
    if (options.mode === 'image') return this.get(this.key(page, 'image', options.language));
    if (!options.forceOcr) {
      const key = this.key(page, 'text', options.language), text = this.get(key);
      if (text && (text.text.trim() || this.corrections.has(key))) return text;
    }
    return this.get(this.key(page, 'ocr', options.language));
  }
  updateText(page: WordPage, text: string, options: EpubPageOptions) {
    if (page.method !== 'image') this.corrections.set(this.key(page.page, page.method, options.language), { ...page, text });
  }
  private stopWorkers() {
    clearTimeout(this.idleTimer); this.generation++;
    for (const slot of this.slots) {
      if (!slot) continue;
      slot.notify = () => {};
      if (slot.worker) void slot.worker.terminate().catch(() => {});
    }
    // Pending initialization notices the generation change and terminates when ready.
    this.slots = []; this.workerLanguage = '';
  }
  dispose() {
    this.disposed = true; this.running?.abort(); this.stopWorkers();
    this.cache.clear(); this.autoMethods.clear(); this.corrections.clear(); this.cacheBytes = 0;
  }
  private async worker(index: number, language: WordOptions['language'], signal: AbortSignal, notify: WorkerSlot['notify']) {
    if (this.workerLanguage && this.workerLanguage !== language) this.stopWorkers();
    this.workerLanguage = language; clearTimeout(this.idleTimer);
    if (!this.slots[index]) {
      const generation = this.generation;
      // Let the first worker populate the model cache while it starts recognition.
      const first = this.slots.find(slot => slot)?.pending;
      const slot: WorkerSlot = { pending: undefined!, notify };
      slot.pending = (async () => {
        if (first) await first;
        cancelled(signal);
        const { createWorker } = await import('tesseract.js');
        cancelled(signal);
        const worker = await createWorker(language, 1, {
          workerPath: '/ocr/worker.min.js', corePath: '/ocr/core', langPath: '/ocr/lang',
          gzip: true, cacheMethod: 'write', cachePath: MODEL_CACHE, workerBlobURL: false,
          logger: message => slot.notify(message), errorHandler: () => {},
        });
        if (this.disposed || generation !== this.generation || signal.aborted) {
          await worker.terminate(); throw new Error('操作已取消。');
        }
        slot.worker = worker; return worker;
      })();
      this.slots[index] = slot;
    }
    this.slots[index].notify = notify;
    return abortable(this.slots[index].pending, signal);
  }

  async convert(options: EpubPageOptions, progress: Progress, signal?: AbortSignal, refresh = false): Promise<EpubConversion> {
    if (this.disposed) throw new Error('请重新选择 PDF 文件。');
    if (this.running) throw new Error('请等待当前转换完成。');
    cancelled(signal);
    const start = performance.now(), indices = pageRange(options.range, this.file.pages);
    if (refresh) {
      const selected = new Set(indices.map(index => index + 1));
      for (const page of selected) this.autoMethods.delete(page);
      for (const [key, entry] of this.cache) if (selected.has(entry.page.page)) { this.cacheBytes -= entry.bytes; this.cache.delete(key); }
      for (const [key, page] of this.corrections) if (selected.has(page.page)) this.corrections.delete(key);
    }
    const pages = new Array<WordPage>(indices.length), jobs: { page: number; index: number }[] = [];
    indices.forEach((index, at) => { const page = this.cached(index + 1, options); if (page) pages[at] = page; else jobs.push({ page: index + 1, index: at }); });
    const reused = indices.length - jobs.length;
    if (!jobs.length) { progress(`已复用 ${reused} 页，无需重复转换。`); return { pages, reused, elapsedMs: performance.now() - start }; }
    const controller = new AbortController(); this.running = controller;
    const stop = () => controller.abort(); signal?.addEventListener('abort', stop, { once: true });
    const terminate = () => this.stopWorkers(); controller.signal.addEventListener('abort', terminate, { once: true });
    clearTimeout(this.idleTimer);
    let doc: PDFDocumentProxy | undefined, next = 0, complete = reused, lastNotice = 0;
    const runningPages = new Set<number>();
    const report = (message: string, force = false) => {
      if (controller.signal.aborted) return;
      if (force || performance.now() - lastNotice > 150) {
        progress(`已完成 ${complete} / ${indices.length} 页${reused ? `（复用 ${reused} 页）` : ''} · ${message}`); lastNotice = performance.now();
      }
    };
    try {
      report('正在读取 PDF…', true); doc = await openEpubPdf(this.file.bytes.slice()); cancelled(controller.signal);
      const run = async (lane: number) => {
        while (next < jobs.length) {
          cancelled(controller.signal);
          const job = jobs[next++];
          let canvas: HTMLCanvasElement | undefined, page: PDFPageProxy | undefined, result: WordPage;
          let base = { page: job.page, width: 1000, height: 1400 };
          try {
            page = await doc!.getPage(job.page);
            const viewport = page.getViewport({ scale: 1 });
            base = { page: job.page, width: viewport.width, height: viewport.height };
            // Safe default for scans and comics: preserve the page instead of guessing its text.
            const automaticText = options.mode === 'auto' ? textLines(await page.getTextContent(), viewport) : '';
            const automaticImage = options.mode === 'auto' && !readableText(automaticText);
            if (options.mode === 'auto') this.autoMethods.set(job.page, automaticImage ? 'image' : 'text');
            if (options.mode === 'image' || automaticImage) {
              report(`正在生成第 ${job.page} 页图片…`);
              canvas = await render(page, 1800, controller.signal);
              const blob = await jpeg(canvas); cancelled(controller.signal);
              result = { ...base, text: '', method: 'image', image: new Uint8Array(await blob.arrayBuffer()) };
            } else if (options.mode === 'auto') {
              result = { ...base, text: automaticText, method: 'text' };
            } else {
              const textKey = this.key(job.page, 'text', options.language);
              const cachedText = this.get(textKey);
              const text = options.forceOcr ? '' : cachedText?.text ?? textLines(await page.getTextContent(), viewport);
              if (!options.forceOcr && !cachedText) this.put(textKey, { ...base, text, method: 'text' });
              if (text.trim()) result = { ...base, text, method: 'text' };
              else {
                report('正在准备文字识别…');
                const worker = await this.worker(lane, options.language, controller.signal, message => {
                  if (message.status === 'recognizing text') report(`正在识别第 ${[...runningPages].sort((a, b) => a - b).join('、')} 页…`);
                });
                runningPages.add(job.page); report(`正在识别第 ${job.page} 页…`, true);
                const target = Math.min(3000, Math.max(viewport.width, viewport.height) * 2.5);
                canvas = await render(page, target, controller.signal);
                const recognized = await abortable(worker.recognize(canvas, {}, { text: true }), controller.signal);
                cancelled(controller.signal);
                result = { ...base, method: 'ocr', text: recognized.data.text.trim().replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, '$1').replace(/[ \t]+([，。！？；：、])/g, '$1') };
                runningPages.delete(job.page);
              }
            }
          } catch (error) {
            cancelled(controller.signal);
            if (options.mode === 'editable') throw new Error(`原 PDF 第 ${job.page} 页无法读取，请检查原文件或改用自动模式查看缺页提示。`);
            result = await unavailablePage(job.page, base.width, base.height);
            if (options.mode === 'auto') this.autoMethods.set(job.page, 'image');
          } finally { if (canvas) canvas.width = canvas.height = 1; page?.cleanup(); }
          cancelled(controller.signal);
          this.put(this.key(job.page, result.method, options.language), result); pages[job.index] = result;
          complete++; report(`第 ${job.page} 页已完成`, true);
        }
      };
      // Catch inside every lane so one failure cancels all siblings before document cleanup.
      let firstFailure: unknown;
      const lanes = Array.from({ length: Math.min(concurrency(), jobs.length) }, (_, i) => run(i).catch(error => {
        if (firstFailure === undefined) firstFailure = error;
        controller.abort(); throw error;
      }));
      await Promise.allSettled(lanes);
      if (firstFailure !== undefined) throw firstFailure;
      cancelled(controller.signal);
      return { pages, reused, elapsedMs: performance.now() - start };
    } catch (error) {
      this.stopWorkers();
      if (signal?.aborted || this.disposed) throw new Error('操作已取消。已完成的页面可在再次转换时继续使用。');
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop); controller.signal.removeEventListener('abort', terminate);
      if (doc) await doc.destroy();
      this.running = undefined;
      for (const slot of this.slots) if (slot) slot.notify = () => {};
      if (!this.disposed && this.slots.length) this.idleTimer = setTimeout(() => this.stopWorkers(), WORKER_IDLE_MS);
    }
  }
}
