'use client';

import { useEffect, useRef, useState } from 'react';
import { Download, FileText, X } from 'lucide-react';
import { ToolFilePanel, ToolHeading, ToolSettingsHeading } from './tool-workspace';
import { fileSize } from '../lib/pdf/export';
import { OFD_MAX_FILE_MB, inspectOfd, ofdErrorMessage, ofdToPdf, type OfdFile } from '../lib/ofd/convert';
import { cancelled, downloadBytes, pageRange, safeStem } from '../lib/pdf/tools';

type Result = Awaited<ReturnType<typeof ofdToPdf>> & { pages: number };

export default function OfdTool({ active, onBusy }: { active: boolean; onBusy: (busy: boolean) => void }) {
  const [source, setSource] = useState<OfdFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState('');
  const [range, setRange] = useState('');
  const [dpi, setDpi] = useState(180);
  const [result, setResult] = useState<Result | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!source) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(source.preview);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [source]);

  async function run(action: (signal: AbortSignal, progress: (text: string) => void) => Promise<void>) {
    if (controller.current) return;
    const task = new AbortController();
    controller.current = task;
    setError('');
    setStatus('正在准备…');
    onBusy(true);
    try {
      await action(task.signal, text => {
        if (!task.signal.aborted) setStatus(text);
      });
    } catch (cause) {
      setError(task.signal.aborted ? '操作已取消。' : ofdErrorMessage(cause));
    } finally {
      controller.current = null;
      setStatus('');
      onBusy(false);
    }
  }

  function load(file?: File) {
    if (!file) return;
    void run(async (signal, progress) => {
      const next = await inspectOfd(file, progress, signal);
      cancelled(signal);
      setSource(next);
      setRange('');
      setResult(null);
    });
  }

  let indices: number[] = [];
  let rangeError = '';
  if (source) {
    try { indices = pageRange(range, source.pages); }
    catch (cause) { rangeError = ofdErrorMessage(cause); }
  }

  function convert() {
    if (!source || !indices.length) return;
    void run(async (signal, progress) => {
      const next = await ofdToPdf(source, indices, dpi, progress, signal);
      cancelled(signal);
      setResult({ ...next, pages: indices.length });
    });
  }

  return <section className="pdf-tools" hidden={!active}>
    <ToolHeading tool="ofd-to-pdf" />
    <div className="tool-grid" onDragOver={event => event.preventDefault()} onDrop={event => {
      event.preventDefault();
      event.stopPropagation();
      if (!status) load(event.dataTransfer.files[0]);
    }}>
      <ToolFilePanel title="导入 OFD 文档" hint={`选择或拖入 .ofd 文件，单个文件不超过 ${OFD_MAX_FILE_MB} MB。`}
        action={source ? '更换 OFD 文件' : '选择 OFD 文件'} loaded={!!source} disabled={!!status}
        onChoose={() => input.current?.click()}>
        <input ref={input} type="file" accept=".ofd,application/ofd" aria-label="导入 OFD 文件" hidden
          onChange={event => { load(event.target.files?.[0]); event.target.value = ''; }} />
      </ToolFilePanel>
      <aside className="tool-options">
        <fieldset disabled={!!status}>
          <ToolSettingsHeading>导出设置</ToolSettingsHeading>
          <label className="select-field">转换页码
            <input value={range} onChange={event => { setRange(event.target.value); setResult(null); }}
              placeholder="全部页，或 1-3,5" disabled={!source} />
          </label>
          {rangeError && <p className="inline-error" role="alert">{rangeError}</p>}
          <label className="select-field">清晰度
            <select value={dpi} onChange={event => { setDpi(Number(event.target.value)); setResult(null); }}>
              <option value={130}>较小文件 · 130 DPI</option>
              <option value={180}>标准 · 180 DPI</option>
              <option value={240}>高清 · 240 DPI</option>
            </select>
          </label>
          <p className="note">导出为图片型 PDF。缺少内嵌字体时会使用替代字体。印章以页面上的外观呈现，验签请使用原 OFD。</p>
          <button className={result ? 'button full' : 'button primary full'} disabled={!indices.length}
            onClick={convert}>{result ? '重新转换' : '开始转换'}</button>
          {result && source && <button className="button primary full word-download" onClick={() => {
            downloadBytes(result.bytes, safeStem(source.file.name.replace(/\.ofd$/i, '')) + '.pdf', 'application/pdf');
          }}><Download size={16} />下载 PDF</button>}
        </fieldset>
      </aside>
      {source && <div className="tool-main tool-content" aria-label="文件和预览">
        <div className="selected-tool-file">
          <FileText size={28} aria-hidden="true" />
          <div><strong>{source.file.name}</strong><span>{source.pages} 页 · {fileSize(source.file.size)}</span></div>
          <span className="file-ready">已载入</span>
        </div>
        {(source.hasRenderingWarnings || result?.hasRenderingWarnings) && <p className="office-warning" role="status">
          部分字体、图片或版式元素可能与原文件不同，请核对预览及导出的页面。
        </p>}
        <div className="office-preview-bar"><h3>OFD 首页预览</h3></div>
        {previewUrl && <div className="conversion-page-preview"><img src={previewUrl} alt="OFD 首页预览" /></div>}
      </div>}
    </div>
    {status && <div className="tool-progress">
      <div className="spinner" aria-hidden="true" />
      <span role="status">{status}</span>
      <button onClick={() => { controller.current?.abort(); setStatus('正在取消…'); }}>取消</button>
    </div>}
    {error && <div className="tool-result error" role="alert">{error}<button aria-label="关闭 OFD 错误" onClick={() => setError('')}><X size={15} /></button></div>}
    {result && !status && <p className="tool-result" role="status">已生成 {result.pages} 页 PDF（{fileSize(result.bytes.byteLength)}），可下载。</p>}
  </section>;
}
