'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, FilePenLine, FileUp, ScanText, Undo2, X } from 'lucide-react';
import { ToolHeading } from './tool-workspace';
import { downloadBytes, inspectPdf, readToolFile, safeStem, type ToolFile } from '../lib/pdf/tools';
import { changedText, editedBackground, exportEditedPdf, recognizeLayout, type EditablePage } from '../lib/pdf/layout-editor';
import { assetUrl } from '../lib/pdf/asset-url';

type Selection = { page: number; block: string };
type Props = { active: boolean; current: { name: string; bytes: Uint8Array } | null; onBusy: (busy: boolean) => void };

function DocumentPage({ page, selected, disabled, select, edit }: {
  page: EditablePage; selected: string | undefined; disabled: boolean;
  select: (block: string) => void; edit: (block: string, text: string) => void;
}) {
  const paper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [image, setImage] = useState('');
  const [previewError, setPreviewError] = useState('');
  const measure = useRef<CanvasRenderingContext2D | null>(null);
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    if (paper.current) observer.observe(paper.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let cancelled = false;
    let url = '';
    const create = async () => {
      const blob = page.blocks.some(changedText) ? await editedBackground(page) : page.image;
      if (cancelled) return;
      url = URL.createObjectURL(blob);
      setImage(url); setPreviewError('');
    };
    const timer = window.setTimeout(() => { void create().catch(() => { if (!cancelled) setPreviewError('修改预览生成失败，请撤销后重试。'); }); }, page.blocks.some(changedText) ? 100 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); if (url) URL.revokeObjectURL(url); };
  }, [page]);
  const scale = width / page.width;
  return <article className="layout-document-page" aria-label={`第 ${page.page} 页`}>
    <header><span>第 {page.page} 页</span><span>{page.blocks.length} 处文字{page.warning ? ' · 需核对' : ''}</span></header>
    {page.warning && <p className="layout-page-warning" role="status">{page.warning}</p>}
    {previewError && <p className="layout-page-warning" role="alert">{previewError}</p>}
    <div ref={paper} className="layout-paper" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
      {image && <img className="layout-page-image" src={image} alt={`原第 ${page.page} 页，表格与图片原貌预览`} loading="lazy" />}
      {width > 0 && page.blocks.map(block => {
        const active = selected === block.id;
        const dirty = changedText(block);
        const textWidth = Math.max(1, block.width);
        if (!measure.current) measure.current = document.createElement('canvas').getContext('2d')!;
        measure.current.font = `${block.size}px Arial, "Layout Chinese", sans-serif`;
        const lines = block.text.split('\n');
        const fontSize = Math.max(1, Math.min(block.size, block.height / (lines.length * 1.15), ...lines.filter(Boolean).map(line => textWidth * block.size / Math.max(1, measure.current!.measureText(line).width))));
        const style = { left: block.x * scale, top: block.y * scale, width: textWidth * scale, height: block.height * scale,
          fontSize: fontSize * scale, lineHeight: '1.15', color: block.color, transform: `rotate(${block.angle}rad)` };
        return active ? <textarea key={block.id} autoFocus className="layout-text-block editing" aria-label={`编辑第 ${page.page} 页文字 ${block.id}`} style={style}
          value={block.text} disabled={disabled} spellCheck={false} onChange={event => edit(block.id, event.target.value)} /> :
          <button key={block.id} className={`layout-text-block${dirty ? ' modified' : ''}`} style={style} disabled={disabled}
            aria-label={`编辑文字：${block.text || '已删除'}`} onClick={() => select(block.id)}>{dirty ? block.text : ''}</button>;
      })}
    </div>
  </article>;
}

export default function PdfLayoutEditor({ active, current, onBusy }: Props) {
  const [file, setFile] = useState<ToolFile | null>(null);
  const [pages, setPages] = useState<EditablePage[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [range, setRange] = useState('');
  const [language, setLanguage] = useState<'chi_sim+eng' | 'eng'>('chi_sim+eng');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const undo = useRef<EditablePage[][]>([]);
  const block = pages.find(p => p.page === selection?.page)?.blocks.find(b => b.id === selection?.block);
  const count = pages.reduce((sum, page) => sum + page.blocks.filter(changedText).length, 0);

  useEffect(() => {
    if (!active) return;
    const font = new FontFace('Layout Chinese', `url(${assetUrl('office-assets/NotoSansSC-Regular.ttf')})`);
    void font.load().then(loaded => document.fonts.add(loaded)).catch(() => {});
  }, [active]);
  async function task(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const job = new AbortController();
    controller.current = job;
    setBusy('正在准备'); setError(''); setMessage(''); onBusy(true);
    try { await action(job.signal); } catch (error) {
      setError(job.signal.aborted ? '已取消，可重新识别。' : error instanceof Error ? error.message : '处理失败，请重试。');
    } finally { controller.current = null; setBusy(''); onBusy(false); }
  }
  function load(next: ToolFile) {
    setFile(next); setPages([]); setSelection(null); setRange(''); undo.current = [];
  }
  async function upload(files: File[]) {
    if (files[0]) await task(async () => load(await readToolFile(files[0])));
  }
  async function recognize() {
    if (!file) return;
    if (count && !window.confirm('重新识别会清除当前文字修改，是否继续？')) return;
    await task(async signal => {
      const result = await recognizeLayout(file, range, language, setBusy, signal);
      if (signal.aborted) return;
      setPages(result); setSelection(null); undo.current = [];
      setMessage('识别完成，点击页面中的文字即可修改，向下滚动查看全部页面。');
    });
  }
  function edit(pageNumber: number, id: string, text: string) {
    if (busy) return;
    text = text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    undo.current = [...undo.current.slice(-79), pages];
    setPages(pages.map(page => page.page === pageNumber ? { ...page, blocks: page.blocks.map(block => block.id === id ? { ...block, text } : block) } : page));
    setMessage('');
  }
  async function download() {
    if (!file || !pages.length) return;
    await task(async signal => {
      const bytes = await exportEditedPdf(file, pages, setBusy, signal);
      if (signal.aborted) return;
      downloadBytes(bytes, `${safeStem(file.name)}-已编辑.pdf`, 'application/pdf');
      setMessage(`已导出 ${pages.length} 页 PDF，包含 ${count} 处文字修改。`);
    });
  }
  return <section className="pdf-tools layout-editor" hidden={!active}>
    <ToolHeading tool="word" description="保留表格、图片和印章，在原页面修改文字并导出 PDF。" />
    <input ref={input} type="file" accept=".pdf,application/pdf" aria-label="选择编辑 PDF" hidden onChange={event => { void upload(Array.from(event.target.files || [])); event.target.value = ''; }} />
    <div className="layout-toolbar">
      <button className="button" disabled={!!busy} onClick={() => input.current?.click()}><FileUp size={17}/>{file ? '更换 PDF' : '选择 PDF'}</button>
      {file && <span className="layout-filename" title={file.name}>{file.name}<small>{file.pages} 页{pages.length ? `，已修改 ${count} 处` : ''}</small></span>}
      <div className="layout-toolbar-actions">
        {pages.length > 0 && <button className="button" disabled={!!busy || !undo.current.length} onClick={() => { const previous = undo.current.pop(); if (previous) setPages(previous); }}><Undo2 size={16}/>撤销</button>}
        <button className="button" disabled={!file || !!busy} onClick={recognize}><ScanText size={17}/>{pages.length ? '重新识别' : '识别可编辑文字'}</button>
        <button className="button primary" disabled={!pages.length || !!busy} onClick={download}><Download size={17}/>导出编辑后的 PDF</button>
      </div>
    </div>
    {!pages.length ? <div className="layout-start" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void upload(Array.from(event.dataTransfer.files)); }}>
      <div className="layout-start-paper"><FilePenLine size={38}/><h3>{file ? '文件已准备好' : '把 PDF 拖到这里'}</h3><p>识别后，在连续页面中点击文字修改。</p>
        {!file && <button className="button primary" disabled={!!busy} onClick={() => input.current?.click()}>选择 PDF</button>}
        {current && <button className="button" disabled={!!busy} onClick={() => void task(async () => load(await inspectPdf(current.bytes, current.name)))}>使用编辑器的原始文件</button>}
      </div>
      <div className="layout-import-settings"><label>识别页码<input aria-label="识别页码" placeholder="全部页，或 1-3,5" value={range} disabled={!!busy} onChange={event => setRange(event.target.value)}/></label>
        <label>扫描识别语言<select aria-label="扫描识别语言" value={language} disabled={!!busy} onChange={event => setLanguage(event.target.value as typeof language)}><option value="chi_sim+eng">简体中文 + 英文</option><option value="eng">英文</option></select></label>
        <p>文字版 PDF 直接读取文字，扫描页自动 OCR。印章与图片保留原貌。</p>
      </div>
    </div> : <div className="layout-workspace">
      <div className="layout-pages" aria-label="连续页面预览">{pages.map(page => <DocumentPage key={page.page} page={page} disabled={!!busy}
        selected={selection?.page === page.page ? selection.block : undefined} select={id => setSelection({ page: page.page, block: id })} edit={(id, text) => edit(page.page, id, text)} />)}</div>
      <aside className="layout-inspector" aria-label="文字编辑面板"><h3>{block ? `第 ${selection!.page} 页文字` : '点击文字开始编辑'}</h3>
        {block ? <><label>文字内容<textarea aria-label="当前选中文字" value={block.text} disabled={!!busy} onChange={event => edit(selection!.page, block.id, event.target.value)}/></label>
          <button className="button" disabled={!!busy || !changedText(block)} onClick={() => edit(selection!.page, block.id, block.original)}>恢复这段原文</button>
          <p>文字会缩小以适应原位置。可清空内容删除文字。修改部分的字体可能与原字体不同。</p>
          {block.source === 'ocr' && <p>扫描页修改会覆盖原文字区域。文字与印章、花纹重叠时，请核对效果后导出。</p>}
        </> : <p>蓝色边框显示当前编辑区域。向下滚动可直接编辑后续页面。</p>}
        <div className="layout-document-summary"><span>预览页数<strong>{pages.length}</strong></span><span>修改处数<strong>{count}</strong></span></div>
      </aside>
    </div>}
    {busy && <div className="tool-progress" role="status"><div className="spinner"/><span>{busy}</span><button onClick={() => controller.current?.abort()}>取消</button></div>}
    {error && <div className="tool-result error" role="alert">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={16}/></button></div>}
    {message && <p className="tool-result" role="status">{message}</p>}
  </section>;
}
