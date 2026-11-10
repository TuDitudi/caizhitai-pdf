'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight, BookOpen, ChevronRight, Crop, FileImage, FileText, Files,
  Image, Presentation, Scissors, Search, ShieldCheck, Table2, X, type LucideIcon,
} from 'lucide-react';
import type { ToolTab } from './pdf-tools';

type ToolEntry = {
  id: ToolTab;
  label: string;
  description: string;
  keywords: string;
  icon: LucideIcon;
};

const groups: { id: string; label: string; tools: ToolEntry[] }[] = [
  { id: 'organize', label: '整理 PDF', tools: [
    { id: 'crop', label: '裁剪与排版', description: '裁边、缩放内容，调整纸张和页面顺序。', keywords: '裁剪pdf 扫描件 边框 页边距 旋转 删除 a4 crop resize', icon: Crop },
    { id: 'merge', label: '合并 PDF', description: '按指定顺序合并多份 PDF。', keywords: '拼接 合并文件 pdf合并 merge combine', icon: Files },
    { id: 'split', label: '按页分割', description: '按页码提取页面，或拆成多份文件。', keywords: '拆分 pdf分割 分页 提取页面 split extract', icon: Scissors },
  ] },
  { id: 'export', label: '从 PDF 转出', tools: [
    { id: 'word', label: 'PDF 转 Word', description: '提取文字或识别扫描件，导出 DOCX。', keywords: 'pdf2word doc docx ocr 文字识别', icon: FileText },
    { id: 'epub', label: 'PDF 转 EPUB', description: '制作带封面的电子书，支持漫画和扫描件。', keywords: 'pdf2epub ebook 电子书 封面 漫画', icon: BookOpen },
    { id: 'pdf-to-images', label: 'PDF 转图片', description: '按页导出 PNG 或 JPG 图片。', keywords: 'pdf2jpg pdf2png jpeg jpg png image 导出图片', icon: FileImage },
    { id: 'pdf-to-ppt', label: 'PDF 转 PPT', description: '每页生成一张保留原貌的幻灯片。', keywords: 'pdf2ppt pptx powerpoint 幻灯片 演示文稿', icon: Presentation },
    { id: 'pdf-to-excel', label: 'PDF 转 Excel', description: '提取表格或按页导出图片到工作簿。', keywords: 'pdf2excel xlsx xls 表格 ocr 文字识别', icon: Table2 },
  ] },
  { id: 'import', label: '转为 PDF', tools: [
    { id: 'images-to-pdf', label: '图片转 PDF', description: '多张图片排序后合成一份 PDF。', keywords: 'jpg2pdf png2pdf jpg jpeg png webp bmp gif image 照片', icon: Image },
    { id: 'ppt-to-pdf', label: 'PPT 转 PDF', description: '将 PPT 或 PPTX 幻灯片导出为 PDF。', keywords: 'ppt2pdf pptx powerpoint 幻灯片 演示文稿', icon: Presentation },
    { id: 'excel-to-pdf', label: 'Excel 转 PDF', description: '选择工作表，自动分页导出 PDF。', keywords: 'excel2pdf xls xlsx xlsm 表格 工作簿', icon: Table2 },
  ] },
];

const tools = groups.flatMap(group => group.tools);

export function toolHref(tool: ToolTab | null) {
  return tool ? `#/tools/${tool}` : '#/';
}

export function toolFromHash(hash: string): ToolTab | null {
  return tools.find(tool => toolHref(tool.id) === hash)?.id ?? null;
}

export function toolLabel(id: ToolTab) {
  return tools.find(tool => tool.id === id)?.label;
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
    const all = label + keywords + normalize(tool.description);
    const score = label === query ? 4 : label.includes(query) ? 3 : keywords.includes(query) ? 2 : terms.every(term => all.includes(term)) ? 1 : 0;
    return { tool, score };
  }).filter(match => match.score > 0).sort((a, b) => b.score - a.score).map(match => match.tool);
}

function SearchField({ value, onChange, onSubmit, placeholder, disabled }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  placeholder: string;
  disabled?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <form className="tool-search-field" role="search" onSubmit={onSubmit}>
    <Search size={19} aria-hidden="true" />
    <input ref={input} type="search" aria-label="搜索工具" placeholder={placeholder} value={value}
      autoComplete="off" disabled={disabled} onChange={event => onChange(event.target.value)} />
    {value && <button type="button" aria-label="清空搜索" disabled={disabled}
      onClick={() => { onChange(''); input.current?.focus(); }}><X size={17} /></button>}
  </form>;
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
      placeholder="搜索或切换工具" onSubmit={submit} disabled={disabled} />
    {open && !disabled && <div className="workspace-search-results">
      {results.length ? <ul aria-label="工具搜索结果">{results.map(tool => <li key={tool.id}>
        <a href={toolHref(tool.id)} onClick={() => setOpen(false)}><tool.icon size={17} aria-hidden="true" />{tool.label}<ChevronRight size={15} aria-hidden="true" /></a>
      </li>)}</ul> : <p role="status">没找到匹配的工具。试试「合并」或「图片」。</p>}
    </div>}
  </div>;
}

export function ToolNav({ active, disabled }: { active: ToolTab; disabled: boolean }) {
  const current = useRef<HTMLAnchorElement>(null);
  useEffect(() => { current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);
  return <nav className="feature-nav" aria-label="PDF 功能">
    {tools.map(tool => <a key={tool.id} href={toolHref(tool.id)} ref={active === tool.id ? current : undefined}
      aria-current={active === tool.id ? 'page' : undefined} aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined} onClick={event => { if (disabled) event.preventDefault(); }}>{tool.label}</a>)}
  </nav>;
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
      <a className="directory-tool" href={toolHref(tool.id)} aria-label={tool.label}>
        <span className="directory-tool-icon"><tool.icon size={20} aria-hidden="true" /></span>
        <span className="directory-tool-text"><strong>{tool.label}</strong><span>{tool.description}</span></span>
        <ArrowRight size={16} className="directory-arrow" aria-hidden="true" />
      </a>
    </li>;
  }

  return <div className="tool-directory" tabIndex={-1} id="tool-directory">
    <section className="directory-hero" aria-labelledby="directory-heading">
      <div className="directory-hero-inner">
        <div className="directory-intro">
          <h1 id="directory-heading">找到你需要的 PDF 工具</h1>
          <p>裁剪和整理页面，在 PDF、图片与办公文档之间转换。</p>
          <SearchField value={query} onChange={setQuery} onSubmit={submit} placeholder="搜索工具，如：裁剪、JPG、Word" />
          <span className="directory-privacy"><ShieldCheck size={16} aria-hidden="true" />文件在浏览器内处理</span>
        </div>
        <div className="directory-art" aria-hidden="true">
          <div className="directory-sheet directory-sheet-back" />
          <div className="directory-sheet directory-sheet-front"><b>PDF</b><i /><i /><i /><i /></div>
          <div className="directory-cut"><i /><i /><i /><i /></div>
        </div>
      </div>
    </section>
    <section className="directory-catalog" aria-labelledby="catalog-heading">
      <div className="directory-catalog-heading">
        <h2 id="catalog-heading">{filtering ? '搜索结果' : '全部工具'}</h2>
        <span role="status">{results.length} 项工具</span>
      </div>
      {filtering ? results.length ? <ul className="directory-results">{results.map(row)}</ul>
        : <div className="directory-empty"><Search size={25} aria-hidden="true" /><p>没找到匹配的工具。试试「合并」或「Excel」。</p></div>
        : <div className="directory-groups">{groups.map(group => <section className={`directory-group directory-${group.id}`} key={group.id}>
          <h3>{group.label}</h3><ul>{group.tools.map(row)}</ul>
        </section>)}</div>}
    </section>
  </div>;
}
