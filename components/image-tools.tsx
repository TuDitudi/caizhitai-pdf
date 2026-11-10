'use client';
/* Browser-local blob URLs and thumbnails must never go through a server image optimizer. */
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDown, ArrowUp, Check, Download, FileText, RotateCw, Trash2, X } from 'lucide-react';
import { ToolFilePanel, ToolHeading, ToolNotes, ToolSettingsHeading } from './tool-workspace';
import { openPdf, renderPage } from '../lib/pdf/engine';
import { fileSize } from '../lib/pdf/export';
import { imagePageSize, imagesToPdf, pdfToImages, readImageFile, type ImageFile, type ImagePdfOptions, type PageImage, type PdfImageOptions } from '../lib/pdf/images';
import { cancelled, downloadBytes, inspectPdf, pageRange, readToolFile, safeStem, zipPdfs, type ToolFile } from '../lib/pdf/tools';

type Props = { active: string; current: { name: string; bytes: Uint8Array } | null; onBusy: (busy: boolean) => void };
const ACCEPT = '.png,.jpg,.jpeg,.webp,.bmp,.gif,image/png,image/jpeg,image/webp,image/bmp,image/gif';
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '转换失败，请检查文件后重试。';

function OriginalPagePreview({ file, page, active }: { file: ToolFile; page: number; active: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!active) return;
    let live = true;
    let document: Awaited<ReturnType<typeof openPdf>> | undefined;
    if (canvas.current) canvas.current.width = canvas.current.height = 1;
    void (async () => {
      try {
        document = await openPdf(file.bytes.slice());
        if (!live) { await document.destroy(); return; }
        const preview = await renderPage(document, page, 0, 850);
        if (live && canvas.current) {
          canvas.current.width = preview.width; canvas.current.height = preview.height;
          canvas.current.getContext('2d')!.drawImage(preview, 0, 0);
        }
        preview.width = preview.height = 1;
      } catch { if (live) setError('预览暂时不可用，可尝试转换或更换文件。'); }
    })();
    return () => { live = false; if (document) void document.destroy(); };
  }, [file, page, active]);
  return <div className="conversion-page-preview">{error ? <p>{error}</p> : <canvas ref={canvas} aria-label={`PDF 第 ${page} 页预览`} />}</div>;
}
function ResultPreview({ image }: { image: PageImage }) {
  const element = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const next = URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.name.endsWith('.png') ? 'image/png' : 'image/jpeg' }));
    if (element.current) element.current.src = next;
    return () => URL.revokeObjectURL(next);
  }, [image]);
  return <div className="conversion-page-preview"><img ref={element} alt={`已转换的第 ${image.page} 页`} /></div>;
}
function Thumbnail({ image, alt, style }: { image: ImageFile; alt: string; style?: CSSProperties }) {
  const element = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(image.thumbnail);
    if (element.current) element.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [image.thumbnail]);
  return <img ref={element} alt={alt} style={style} />;
}
function ImageLayout({ image, options }: { image: ImageFile; options: ImagePdfOptions }) {
  const [w, h] = imagePageSize(image, options), margin = options.paper === 'image' ? 0 : options.margin * 72 / 25.4;
  const rw = image.rotation % 180 ? image.height : image.width, rh = image.rotation % 180 ? image.width : image.height;
  const scale = Math.min((w - margin * 2) / rw, (h - margin * 2) / rh);
  return <div className="image-layout-frame"><div className="image-layout-paper" style={{ aspectRatio: w / h, width: `min(100%, ${380 * w / h}px)` }}>
    <Thumbnail image={image} alt={`${image.name} 排版预览`} style={{ width: `${image.width * scale / w * 100}%`, height: `${image.height * scale / h * 100}%`, transform: `translate(-50%, -50%) rotate(${image.rotation}deg)` }} />
  </div></div>;
}

export default function ImageTools({ active, current, onBusy }: Props) {
  const isImages = active === 'images-to-pdf', visible = isImages || active === 'pdf-to-images';
  const [images, setImages] = useState<ImageFile[]>([]), [selected, setSelected] = useState('');
  const [pdf, setPdf] = useState<ToolFile | null>(null), [previewPage, setPreviewPage] = useState(1);
  const [pdfOptions, setPdfOptions] = useState<ImagePdfOptions>({ paper: 'image', margin: 10, limitSize: false });
  const [imageOptions, setImageOptions] = useState<PdfImageOptions>({ range: '', format: 'jpeg', dpi: 150, quality: .9 });
  const [outputName, setOutputName] = useState('图片合并');
  const [results, setResults] = useState<PageImage[]>([]), [resultIndex, setResultIndex] = useState(0);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null), controller = useRef<AbortController | null>(null), lock = useRef(false);
  useEffect(() => () => controller.current?.abort(), []);
  const [noticeTool, setNoticeTool] = useState(active);
  const totalSize = images.reduce((total, image) => total + image.file.size, 0);
  const selectedImage = images.find(image => image.id === selected) || images[0];
  let rangeError = '', selectedPages: number[] = [];
  if (pdf) { try { selectedPages = pageRange(imageOptions.range, pdf.pages); if (selectedPages.length > 200) rangeError = '每次最多转换 200 页，请分批选择页码。'; } catch (err) { rangeError = errorMessage(err); } }

  async function task(fn: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true; const abort = new AbortController(); controller.current = abort;
    setNoticeTool(active); setBusy('正在准备…'); setError(''); setMessage(''); onBusy(true);
    try { await fn(abort.signal); } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(''); controller.current = null; lock.current = false; onBusy(false); }
  }
  function updatePdf(file: ToolFile) { setPdf(file); setPreviewPage(1); setResults([]); setImageOptions(options => ({ ...options, range: '' })); }
  async function addFiles(files: File[]) {
    if (!files.length) return;
    await task(async signal => {
      if (!isImages) { const file = await readToolFile(files[0]); cancelled(signal); updatePdf(file); return; }
      if (images.length + files.length > 100 || totalSize + files.reduce((n, f) => n + f.size, 0) > 200 * 1024 * 1024) throw new Error('最多选择 100 张图片，合计不能超过 200 MB。');
      const added: ImageFile[] = [];
      for (let i = 0; i < files.length; i++) { setBusy(`正在读取图片 ${i + 1} / ${files.length}…`); added.push(await readImageFile(files[i], signal)); }
      cancelled(signal); setImages(previous => [...previous, ...added]); setSelected(added[0].id);
    });
  }
  async function useCurrent() { if (current) await task(async signal => { const file = await inspectPdf(current.bytes, current.name); cancelled(signal); updatePdf(file); }); }
  function moveImage(index: number, offset: number) {
    setImages(previous => { const next = [...previous]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; return next; }); setMessage('');
  }
  function changeImageOptions(next: Partial<PdfImageOptions>) { setImageOptions(options => ({ ...options, ...next })); setResults([]); setResultIndex(0); setMessage(''); setError(''); }
  async function downloadPdf() {
    await task(async signal => {
      const result = await imagesToPdf(images, pdfOptions, setBusy, signal); cancelled(signal);
      downloadBytes(result.bytes, `${safeStem(outputName || '图片合并')}.pdf`, 'application/pdf');
      setMessage(`已生成 ${images.length} 页 PDF，${fileSize(result.bytes.byteLength)}。${result.compressed ? '为满足体积限制，已压缩图片并将透明区域铺为白色。' : '请打开下载文件查看。'}`);
    });
  }
  async function convertAndDownload() {
    if (!pdf) return;
    await task(async signal => {
      setResults([]);
      const result = await pdfToImages(pdf, imageOptions, setBusy, signal); cancelled(signal);
      const generated = result.images;
      if (generated.length === 1) downloadImage(generated[0]);
      else {
        setBusy('正在打包页面图片…'); const zip = await zipPdfs(generated); cancelled(signal);
        downloadBytes(zip, `${safeStem(pdf.name)}-页面图片.zip`, 'application/zip');
      }
      setResults(generated); setResultIndex(0);
      setMessage(`已生成 ${generated.length} 张图片${generated.length > 1 ? '，已打包 ZIP' : ''}，合计 ${fileSize(generated.reduce((n, image) => n + image.bytes.byteLength, 0))}。${result.reduced ? '超大页面已适当降低清晰度，以适应设备内存。' : ''}`);
    });
  }
  function downloadImage(image: PageImage) { downloadBytes(image.bytes, image.name, image.name.endsWith('.png') ? 'image/png' : 'image/jpeg'); }

  return <section className="pdf-tools image-tools" style={{ display: visible ? undefined : 'none' }}>
    <ToolHeading tool={isImages ? "images-to-pdf" : "pdf-to-images"} />
  <div className="tool-grid" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); if (!busy) void addFiles(Array.from(e.dataTransfer.files)); }}>
   <ToolFilePanel title={isImages ? '导入要合并的图片' : '导入来源 PDF'}
        hint={isImages ? '可拖入 PNG、JPG、JPEG、WebP、BMP 或 GIF，每张不超过 50 MB。' : '可拖入文字版或扫描版 PDF，按页导出 PNG 或 JPG。'}
        action={isImages ? '添加图片' : pdf ? '更换 PDF' : '选择 PDF'} loaded={Boolean(isImages ? images.length : pdf)}
        disabled={!!busy} onChoose={() => input.current?.click()} onReuse={!isImages && current ? useCurrent : undefined}>
    <input ref={input} aria-label={isImages ? '选择要转 PDF 的图片' : '选择要转图片的 PDF'} type="file" accept={isImages ? ACCEPT : '.pdf,application/pdf'} multiple={isImages} hidden onChange={e => { void addFiles(Array.from(e.target.files || [])); e.target.value = ''; }} />
   </ToolFilePanel>
   <aside className="tool-options"><fieldset disabled={!!busy}>
      {isImages ? <><ToolSettingsHeading>PDF 生成设置</ToolSettingsHeading>
        <label className="select-field">输出文件名<input aria-label="图片 PDF 文件名" value={outputName} onChange={e => setOutputName(e.target.value)} /></label>
        <label className="select-field">页面尺寸<select aria-label="图片 PDF 页面尺寸" value={pdfOptions.paper} onChange={e => setPdfOptions(options => ({ ...options, paper: e.target.value as ImagePdfOptions['paper'] }))}><option value="image">随图片比例（无留白）</option><option value="a4">A4 纵向</option><option value="a4-landscape">A4 横向</option></select></label>
        {pdfOptions.paper !== 'image' && <label className="select-field">四周留白（毫米）<input aria-label="图片 PDF 留白" type="number" min="0" max="40" value={pdfOptions.margin} onChange={e => setPdfOptions(options => ({ ...options, margin: Math.max(0, Math.min(40, Number(e.target.value) || 0)) }))} /></label>}
        <div className="tool-summary"><span>输出页数<strong>{images.length} 页</strong></span><span>原图片合计<strong>{fileSize(totalSize)}</strong></span></div>
    <label className="compression-option"><input type="checkbox" checked={pdfOptions.limitSize} onChange={e => setPdfOptions(options => ({ ...options, limitSize: e.target.checked }))} /><span>不超过原图片合计大小<small>超限时尝试压缩，透明区域铺为白色；仍超限则停止下载。</small></span></label>
        <ToolNotes><p className="note">每张图片占一页，等比缩放、完整显示。优先复用 PNG 和 JPG 原图；手机照片会按拍摄方向处理。</p>
        <p className="note">未启用体积限制时优先保留画质，PDF 文件结构可能增加体积。</p></ToolNotes>
    <button className="button primary full" disabled={!images.length} onClick={downloadPdf}><Download size={16} />生成并下载 PDF</button>
      </> : <><ToolSettingsHeading>图片导出设置</ToolSettingsHeading>
        <label className="select-field">图片格式<select aria-label="导出图片格式" value={imageOptions.format} onChange={e => changeImageOptions({ format: e.target.value as PdfImageOptions['format'] })}><option value="jpeg">JPG / JPEG（较小体积）</option><option value="png">PNG（无损图片）</option></select></label>
        <label className="select-field">转换页码<input aria-label="转图片页码" placeholder="全部页，或 1-3,5" value={imageOptions.range} onChange={e => changeImageOptions({ range: e.target.value })} /><small>每次最多 200 页，可用逗号选择不连续页面。</small></label>
        {rangeError && <p className="inline-error">{rangeError}</p>}
        <label className="select-field">清晰度<select aria-label="图片清晰度" value={imageOptions.dpi} onChange={e => changeImageOptions({ dpi: Number(e.target.value) })}><option value="72">标准 · 72 DPI</option><option value="150">清晰 · 150 DPI</option><option value="300">高清 · 300 DPI</option></select></label>
        {imageOptions.format === 'jpeg' && <label className="select-field">JPG 画质 · {Math.round(imageOptions.quality * 100)}%<input aria-label="JPG 画质" type="range" min="40" max="100" value={Math.round(imageOptions.quality * 100)} onChange={e => changeImageOptions({ quality: Number(e.target.value) / 100 })} /></label>}
        <div className="tool-summary"><span>选中页面<strong>{rangeError ? '—' : selectedPages.length} 页</strong></span><span>下载方式<strong>{selectedPages.length > 1 ? 'ZIP 压缩包' : '单张图片'}</strong></span></div>
        <ToolNotes><p className="note">导出完整页面，文字和图形都会保留在图片中；这不是提取 PDF 内的独立插图。</p>
        <p className="note">图片与 PDF 的存储方式不同，转图后可能变大。降低清晰度或 JPG 画质可以减小体积；扫描件转高清不会增加原图细节。</p></ToolNotes>
    <button className="button primary full" disabled={!pdf || !!rangeError} onClick={convertAndDownload}><Download size={16} />转换并下载图片</button>
      </>}
    </fieldset></aside>
   <div className="tool-main tool-content" hidden={!(isImages ? images.length : pdf)} aria-label="文件和预览">
      {isImages ? images.length ? <>
        <div className="image-list">{images.map((image, index) => <div className={`image-row ${image.id === selectedImage?.id ? 'selected' : ''}`} key={image.id}>
          <button className="image-select" aria-label={`预览图片 ${index + 1}`} aria-pressed={image.id === selectedImage?.id} disabled={!!busy} onClick={() => setSelected(image.id)}>
            <span className="image-thumb"><Thumbnail image={image} alt="" style={{ transform: `rotate(${image.rotation}deg)` }} /></span>
            <span className="image-file"><strong>{index + 1}. {image.name}</strong><small>{image.rotation % 180 ? image.height : image.width} × {image.rotation % 180 ? image.width : image.height} 像素 · {fileSize(image.file.size)}</small></span>
          </button>
          <div className="merge-controls">
            <button aria-label={`上移图片 ${index + 1}`} disabled={!!busy || index === 0} onClick={() => moveImage(index, -1)}><ArrowUp size={16} /></button>
            <button aria-label={`下移图片 ${index + 1}`} disabled={!!busy || index === images.length - 1} onClick={() => moveImage(index, 1)}><ArrowDown size={16} /></button>
            <button aria-label={`旋转图片 ${index + 1}`} disabled={!!busy} onClick={() => { setImages(previous => previous.map(item => item.id === image.id ? { ...item, rotation: (item.rotation + 90) % 360 } : item)); setMessage(''); }}><RotateCw size={16} /></button>
            <button aria-label={`删除图片 ${index + 1}`} disabled={!!busy} onClick={() => { setImages(previous => previous.filter(item => item.id !== image.id)); setMessage(''); }}><Trash2 size={16} /></button>
          </div>
        </div>)}</div>
        {selectedImage && <div className="image-layout"><div className="preview-heading"><h3>排版预览</h3><span>{pdfOptions.paper === 'image' ? '随图片比例' : pdfOptions.paper === 'a4' ? 'A4 纵向' : 'A4 横向'}</span></div><ImageLayout image={selectedImage} options={pdfOptions} /></div>}
      </> : null : pdf ? <>
        <div className="selected-tool-file"><FileText size={29} /><div><strong>{pdf.name}</strong><span>{pdf.pages} 页 · {fileSize(pdf.bytes.byteLength)}</span></div><span className="file-ready">已载入</span></div>
        <div className="image-layout"><div className="preview-heading"><h3>{results.length ? '转换结果' : '原始页面预览'}</h3>
          {results.length ? <select aria-label="图片结果页码" value={resultIndex} disabled={!!busy} onChange={e => setResultIndex(Number(e.target.value))}>{results.map((image, index) => <option key={image.page} value={index}>第 {image.page} 页</option>)}</select> : <select aria-label="转图片预览页码" value={previewPage} disabled={!!busy} onChange={e => setPreviewPage(Number(e.target.value))}>{Array.from({ length: pdf.pages }, (_, i) => <option key={i} value={i + 1}>第 {i + 1} 页</option>)}</select>}
        </div>
          {results[resultIndex] ? <><ResultPreview image={results[resultIndex]} /><div className="image-result-caption"><span>{results[resultIndex].width} × {results[resultIndex].height} 像素 · {fileSize(results[resultIndex].bytes.byteLength)}</span><button className="button" disabled={!!busy} onClick={() => downloadImage(results[resultIndex])}><Download size={14} />下载当前图片</button></div></> : <OriginalPagePreview key={`${pdf.id}-${previewPage}`} file={pdf} page={previewPage} active={visible && !isImages} />}
        </div>
      </> : null}
       </div>
  </div>
    {busy && <div className="tool-progress" role="status"><div className="spinner" /><span>{busy}</span><button onClick={() => { controller.current?.abort(); setBusy('正在取消…'); }}>取消</button></div>}
    {noticeTool === active && error && <div className="tool-result error" role="alert">{error}<button aria-label="关闭图片工具错误" onClick={() => setError('')}><X size={15} /></button></div>}
    {noticeTool === active && message && <div className="tool-result" role="status"><Check size={17} />{message}<button aria-label="关闭图片工具提示" onClick={() => setMessage('')}><X size={15} /></button></div>}
  </section>;
}
