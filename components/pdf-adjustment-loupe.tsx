import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { fullCrop, layout, type Crop, type Edit } from '../lib/pdf/geometry';
import '../app/pdf-adjustment-loupe.css';

type Point = { x: number; y: number };
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type AdjustmentHandle = ResizeHandle | 'move' | 'content';
export type AdjustmentPreview = {
  handle: AdjustmentHandle;
  pointer: Point;
  page: DOMRectReadOnly;
};

const magnification = 3;
const maxSize = 144;
const inset = 8;
const gap = 18;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function focusPoint({ handle, pointer, page }: AdjustmentPreview, crop: Crop): Point {
  const x = clamp((pointer.x - page.left) / page.width, 0, 1);
  const y = clamp((pointer.y - page.top) / page.height, 0, 1);
  if (handle === 'move' || handle === 'content') return { x, y };
  const right = crop.x + crop.w;
  const bottom = crop.y + crop.h;
  return {
    x: handle.includes('w') ? crop.x : handle.includes('e') ? right : clamp(x, crop.x, right),
    y: handle.includes('n') ? crop.y : handle.includes('s') ? bottom : clamp(y, crop.y, bottom),
  };
}

export function PdfAdjustmentLoupe({ source, preview, edit }: {
  source: HTMLCanvasElement;
  preview: AdjustmentPreview;
  edit: Edit;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const size = Math.min(maxSize, window.innerWidth - 2 * inset, window.innerHeight - 2 * inset);
  const { pointer, page } = preview;
  const left = pointer.x + gap + size + inset <= window.innerWidth ? pointer.x + gap : pointer.x - gap - size;
  const top = pointer.y - gap - size >= inset ? pointer.y - gap - size : pointer.y + gap;

  useLayoutEffect(() => {
    const surface = canvas.current;
    const ctx = surface?.getContext('2d');
    if (!surface || !ctx) return;
    const density = Math.min(3, window.devicePixelRatio || 1);
    const pixels = Math.round(size * density);
    if (surface.width !== pixels || surface.height !== pixels) surface.width = surface.height = pixels;
    const scale = pixels / size;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.fillStyle = '#e5ebf2';
    ctx.fillRect(0, 0, size, size);

    const focus = focusPoint(preview, edit.crop);
    const sx = page.width * magnification;
    const sy = page.height * magnification;
    const x = (value: number) => size / 2 + (value - focus.x) * sx;
    const y = (value: number) => size / 2 + (value - focus.y) * sy;

    let area = fullCrop();
    let image = fullCrop();
    let guide = edit.crop;
    if (preview.handle === 'content') {
      const { x, y, w, h, iw, ih } = layout(edit);
      area = edit.crop;
      image = { x: x / w, y: y / h, w: iw / w, h: ih / h };
      guide = image;
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(x(0), y(0), sx, sy);
    ctx.clip();
    ctx.fillStyle = '#fff';
    ctx.fillRect(x(0), y(0), sx, sy);
    ctx.drawImage(
      source, source.width * area.x, source.height * area.y, source.width * area.w, source.height * area.h,
      x(image.x), y(image.y), image.w * sx, image.h * sy,
    );
    ctx.restore();

    ctx.lineWidth = 3.5;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(x(guide.x), y(guide.y), guide.w * sx, guide.h * sy);
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = '#176bdf';
    ctx.strokeRect(x(guide.x), y(guide.y), guide.w * sx, guide.h * sy);

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, 3.2, 0, 2 * Math.PI);
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.fillStyle = '#176bdf';
    ctx.fill();
  }, [source, preview, edit, page, size]);

  return createPortal(
    <div className="pdf-adjustment-loupe" aria-hidden="true" style={{
      width: size, height: size,
      left: clamp(left, inset, Math.max(inset, window.innerWidth - size - inset)),
      top: clamp(top, inset, Math.max(inset, window.innerHeight - size - inset)),
    }}>
      <canvas ref={canvas} />
      <span>{magnification}×</span>
    </div>, document.body,
  );
}
