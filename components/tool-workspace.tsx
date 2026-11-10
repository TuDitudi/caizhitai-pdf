'use client';

import type { ReactNode } from 'react';
import { ArrowUpFromLine, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { ToolTab } from './pdf-tools';
import { toolDetails } from './tool-navigation';

export function ToolHeading({ tool, description }: { tool: ToolTab; description?: string }) {
  const entry = toolDetails(tool);
  if (!entry) return null;
  return <header className="tool-title">
    <div className="tool-identity">
      <span className="tool-emblem" aria-hidden="true"><entry.icon size={25} /></span>
      <div><h2>{entry.label}</h2><p>{description ?? entry.description}</p></div>
    </div>
    <span className="tool-local"><ShieldCheck size={15} aria-hidden="true" />文件在本机处理</span>
  </header>;
}

type FilePanelProps = {
  title: string;
  hint: string;
  action: string;
  loaded?: boolean;
  disabled?: boolean;
  onChoose: () => void;
  onReuse?: () => void;
  reuseLabel?: string;
  children?: ReactNode;
};

export function ToolFilePanel({ title, hint, action, loaded, disabled, onChoose, onReuse,
  reuseLabel = '使用编辑器的原始文件', children }: FilePanelProps) {
  return <section className="tool-file-panel" data-loaded={Boolean(loaded)} aria-label="导入文件">
    {children}
    <div className="tool-file-surface">
      <span className="tool-file-symbol" aria-hidden="true"><ArrowUpFromLine size={22} /></span>
      <div className="tool-file-copy">
        <h3>{title}</h3>
        <p>{hint}</p>
      </div>
      <div className="tool-file-actions">
        <button type="button" className={loaded ? 'button' : 'button primary'} disabled={disabled} onClick={onChoose}>
          {action}
        </button>
        {onReuse && <button type="button" className="button" disabled={disabled} onClick={onReuse}>{reuseLabel}</button>}
      </div>
    </div>
  </section>;
}

export function ToolSettingsHeading({ children }: { children: ReactNode }) {
  return <h3 className="tool-settings-heading"><SlidersHorizontal size={17} aria-hidden="true" />{children}</h3>;
}

export function ToolNotes({ children }: { children: ReactNode }) {
  return <details className="tool-notes"><summary>使用说明</summary>{children}</details>;
}
