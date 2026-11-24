'use client';

import { useRef, useState, type FormEvent } from 'react';
import {
  Camera, BookOpen, ChevronDown, ChevronRight, Crop, FileImage, FileText, Files, LayoutGrid, MessageSquareText,
  Image, Presentation, Scissors, Search, ShieldCheck, Table2, X, type LucideIcon,
} from 'lucide-react';
import type { ToolTab } from './pdf-tools';

type ToolEntry = {
  id: ToolTab;
  label: string;
  keywords: string;
  icon: LucideIcon;
};

const groups: { id: string; label: string; tools: ToolEntry[] }[] = [
  { id: 'organize', label: '整理 PDF', tools: [
    { id: 'crop', label: '裁剪与排版', keywords: '裁剪pdf 扫描件 边框 页边距 旋转 删除 a4 crop resize 裁边 缩放 页面顺序 调整纸张', icon: Crop },
    { id: 'merge', label: '合并 PDF', keywords: '拼接 合并文件 pdf合并 merge combine 文件顺序', icon: Files },
    { id: 'split', label: '按页分割', keywords: '拆分 pdf分割 分页 提取页面 split extract 提取页面', icon: Scissors },
  ] },
  { id: 'export', label: '从 PDF 转出', tools: [
    { id: 'word', label: 'PDF 转 Word', keywords: 'pdf2word word doc docx ocr 文字识别 pdf编辑 改字 原貌 模板 印章 字形 字体 编辑预览 可编辑', icon: FileText },
    { id: 'epub', label: 'PDF 转 EPUB', keywords: 'pdf2epub ebook 电子书 封面 漫画 扫描件', icon: BookOpen },
    { id: 'pdf-to-images', label: 'PDF 转图片', keywords: 'pdf2jpg pdf2png jpeg jpg png image 导出图片 按页导出', icon: FileImage },
    { id: 'pdf-to-ppt', label: 'PDF 转 PPT', keywords: 'pdf2ppt pptx powerpoint 幻灯片 演示文稿 保留原貌', icon: Presentation },
    { id: 'pdf-to-excel', label: 'PDF 转 Excel', keywords: 'pdf2excel xlsx xls 表格 ocr 文字识别 工作簿', icon: Table2 },
  ] },
  { id: 'import', label: '转为 PDF', tools: [
    { id: 'ofd-to-pdf', label: 'OFD 转 PDF', keywords: 'ofd 转 pdf ofd2pdf 国产版式 电子发票 电子公文 原尺寸 指定页', icon: FileText },
    { id: 'photo-scan', label: '拍照扫描', keywords: '拍照扫描 扫描仪 文档扫描 手机照片 四角 边框 透视 阴影 heic heif scan camera 拉正 增强', icon: Camera },
    { id: 'images-to-pdf', label: '图片转 PDF', keywords: 'jpg2pdf png2pdf jpg jpeg png webp bmp gif image 照片 图片排序', icon: Image },
    { id: 'ppt-to-pdf', label: 'PPT 转 PDF', keywords: 'ppt2pdf pptx powerpoint 幻灯片 演示文稿', icon: Presentation },
    { id: 'excel-to-pdf', label: 'Excel 转 PDF', keywords: 'excel2pdf xls xlsx xlsm 表格 工作簿 工作表 自动分页', icon: Table2 },
  ] },
];

const tools = groups.flatMap(group => group.tools);

export function toolHref(tool: ToolTab | null) {
  return tool ? `#/tools/${tool}` : '#/';
}

export function toolFromHash(hash: string): ToolTab | null {
  return tools.find(tool => toolHref(tool.id) === hash)?.id ?? null;
}

export function toolDetails(id: ToolTab) {
  return tools.find(tool => tool.id === id);
}

export function toolLabel(id: ToolTab) {
  return toolDetails(id)?.label;
}

function normalize(value: string) {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

function searchTools(value: string) {
  const query = normalize(value);
  if (!query) return tools;
  const terms = value.normalize('NFKC').toLowerCase().trim().split(/\s+/);
  return tools.map(tool => {
    const label = normalize(tool.label);
    const keywords = normalize(tool.keywords);
    const all = label + keywords;
    const score = label === query ? 4 : label.includes(query) ? 3 : keywords.includes(query) ? 2 : terms.every(term => all.includes(term)) ? 1 : 0;
    return { tool, score };
  }).filter(match => match.score > 0).sort((a, b) => b.score - a.score).map(match => match.tool);
}

function SearchField({ value, onChange, onSubmit, placeholder, disabled, inputId }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  placeholder: string;
  disabled?: boolean;
  inputId?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <form className="tool-search-field" role="search" onSubmit={onSubmit}>
    <Search size={19} aria-hidden="true" />
    <input ref={input} id={inputId} type="search" aria-label="搜索工具" placeholder={placeholder} value={value}
      autoComplete="off" disabled={disabled} onChange={event => onChange(event.target.value)} />
    {value && <button type="button" aria-label="清空搜索" disabled={disabled}
      onClick={() => { onChange(''); input.current?.focus(); }}><X size={17} /></button>}
  </form>;
}

function SearchMatches({ results, onChoose }: { results: ToolEntry[]; onChoose: () => void }) {
  if (!results.length) return <p role="status">没找到匹配的工具。试试「合并」或「图片」。</p>;
  return <ul aria-label="工具搜索结果">{results.map(tool => <li key={tool.id}>
    <a href={toolHref(tool.id)} onClick={onChoose}>
      <tool.icon size={18} aria-hidden="true" />{tool.label}<ChevronRight size={16} aria-hidden="true" />
    </a>
  </li>)}</ul>;
}

export function WorkspaceSearch({ disabled }: { disabled: boolean }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const results = searchTools(query);
  const box = useRef<HTMLDivElement>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open || disabled || !results.length) return;
    window.location.hash = toolHref(results[0].id);
    setOpen(false);
  }

  return <div className="workspace-search" ref={box}
    onFocus={() => setOpen(true)}
    onPointerDown={event => { if (event.target instanceof HTMLInputElement && !disabled) setOpen(true); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
    onKeyDown={event => {
      if (event.key === 'Escape' && open) {
        event.preventDefault();
        box.current?.querySelector('input')?.focus();
        setOpen(false);
      }
      if (event.key === 'ArrowDown' && event.target instanceof HTMLInputElement) {
        event.preventDefault();
        if (open) box.current?.querySelector('a')?.focus();
        else setOpen(true);
      }
    }}>
    <SearchField value={query} onChange={value => { setQuery(value); setOpen(true); }}
      placeholder="搜索工具" onSubmit={submit} disabled={disabled} />
    {open && !disabled && <div className="workspace-search-results">
      <SearchMatches results={results} onChoose={() => setOpen(false)} />
    </div>}
  </div>;
}

export function ToolNav({ active, disabled }: { active: ToolTab; disabled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  return <div className="tool-switcher" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && expanded) {
      setExpanded(false);
      toggle.current?.focus();
    }
  }}>
      <button ref={toggle} className="tool-switcher-toggle" type="button" disabled={disabled}
        aria-label={`切换工具，当前为${toolLabel(active)}`} aria-expanded={expanded} aria-controls="workspace-tool-links" onClick={() => setExpanded(previous => !previous)}>
        {toolLabel(active)} <ChevronDown size={15} aria-hidden="true" />
      </button>
    <nav className="feature-nav" id="workspace-tool-links" aria-label="切换工具" hidden={!expanded}>
      {tools.map(tool => <a key={tool.id} href={toolHref(tool.id)}
        aria-current={active === tool.id ? 'page' : undefined} aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined} onClick={event => {
          if (disabled) event.preventDefault();
          else {
            setExpanded(false);
            if (expanded && tool.id === active) toggle.current?.focus();
          }
        }}><tool.icon size={15} aria-hidden="true" />{tool.label}</a>)}
    </nav>
  </div>;
}

export function MobileDock({ home, disabled, feedback }: {
  home: boolean;
  disabled: boolean;
  feedback?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const results = searchTools(query);

  function openSearch() {
    const homeInput = home ? document.getElementById('directory-search') : null;
    if (homeInput) {
      homeInput.focus();
      return;
    }
    setQuery('');
    dialog.current?.showModal();
    dialog.current?.querySelector('input')?.focus();
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !results.length) return;
    window.location.hash = toolHref(results[0].id);
    dialog.current?.close();
  }

  return <>
    <nav className="mobile-dock" aria-label="主导航">
      <a href={toolHref(null)} aria-current={home ? 'page' : undefined} aria-disabled={disabled || undefined}
        tabIndex={disabled ? -1 : undefined} onClick={event => { if (disabled) event.preventDefault(); }}>
        <LayoutGrid size={21} aria-hidden="true" />工具
      </a>
      <button type="button" disabled={disabled} onClick={openSearch}><Search size={21} aria-hidden="true" />搜索</button>
      {feedback && <a href={feedback} target="_blank" rel="noopener noreferrer" aria-label="意见与反馈">
        <MessageSquareText size={21} aria-hidden="true" />反馈
      </a>}
    </nav>
    <dialog ref={dialog} className="mobile-search-sheet" aria-labelledby="mobile-search-title">
      <div className="mobile-search-header">
        <h2 id="mobile-search-title">搜索工具</h2>
        <button type="button" className="icon-button" onClick={() => dialog.current?.close()} aria-label="关闭搜索"><X size={21} /></button>
      </div>
      <SearchField value={query} onChange={setQuery} onSubmit={submit} placeholder="搜索裁剪、JPG、Word…" disabled={disabled} />
      <div className="mobile-search-results">
        <SearchMatches results={results} onChoose={() => dialog.current?.close()} />
      </div>
    </dialog>
  </>;
}

export function ToolDirectory() {
  const [query, setQuery] = useState('');
  const results = searchTools(query);
  const filtering = normalize(query).length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (filtering && results.length) window.location.hash = toolHref(results[0].id);
  }

  function row(tool: ToolEntry) {
    return <li key={tool.id}>
      <a className="directory-tool" href={toolHref(tool.id)}>
        <span className="directory-tool-icon"><tool.icon size={20} aria-hidden="true" /></span>
        <span className="directory-tool-name">{tool.label}</span>
        <ChevronRight size={16} className="directory-arrow" aria-hidden="true" />
      </a>
    </li>;
  }

  return <div className="tool-directory" tabIndex={-1} id="tool-directory">
    <section className="directory-hero" aria-labelledby="directory-heading">
      <div className="directory-hero-inner">
        <div className="directory-intro">
          <h1 id="directory-heading"><Crop className="directory-heading-icon" size={25} aria-hidden="true" />PDF 整理与转换</h1>
          <SearchField value={query} onChange={setQuery} onSubmit={submit} inputId="directory-search" placeholder="搜索裁剪、JPG、Word…" />
          <span className="directory-privacy"><ShieldCheck size={16} aria-hidden="true" />文件在浏览器内处理</span>
        </div>
        <div className="directory-art" aria-hidden="true">
          <div className="directory-sheet directory-sheet-back" />
          <div className="directory-sheet directory-sheet-front"><i /><i /><i /><i /></div>
          <div className="directory-cut"><Crop size={61} strokeWidth={1.35} /></div>
        </div>
      </div>
    </section>
    <section className="directory-catalog" aria-labelledby="catalog-heading">
      <div className="directory-catalog-heading">
        <h2 id="catalog-heading">{filtering ? '搜索结果' : '全部工具'}</h2>
        {filtering && <span role="status">{results.length} 项工具</span>}
      </div>
      {filtering ? results.length ? <ul className="directory-results">{results.map(row)}</ul>
        : <div className="directory-empty"><Search size={25} aria-hidden="true" /><p>没找到匹配的工具。试试「合并」或「Excel」。</p></div>
        : <div className="directory-groups">{groups.map(group => <section className={`directory-group directory-${group.id}`} key={group.id}>
          <h3>{group.label}</h3><ul>{group.tools.map(row)}</ul>
        </section>)}</div>}
    </section>
  </div>;
}
