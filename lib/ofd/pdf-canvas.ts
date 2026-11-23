import {
  PDFDocument, PDFName, PDFOperator, PDFOperatorNames, PDFNumber, type PDFPage,
  appendBezierCurve, clip, clipEvenOdd, closePath, concatTransformationMatrix, drawObject, endPath,
  fill, lineTo, moveTo, popGraphicsState, pushGraphicsState, setDashPattern, setFillingRgbColor,
  setGraphicsState, setLineCap, setLineJoin, setLineWidth, setStrokingRgbColor, stroke,
} from 'pdf-lib';
import { cancelled } from '../pdf/tools';

type Point = { x: number; y: number };
type Segment = { kind: 'm' | 'l'; point: Point } |
  { kind: 'c'; points: [Point, Point, Point] } | { kind: 'h' };
type Paint = { alpha: number; composite: string };
type Command = PDFOperator | Paint | { png: string };
const BLENDS = new Map([
  ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'ColorDodge'], ['color-burn', 'ColorBurn'],
  ['hard-light', 'HardLight'], ['soft-light', 'SoftLight'], ['difference', 'Difference'],
  ['exclusion', 'Exclusion'], ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'],
  ['luminosity', 'Luminosity'],
]);
const LINE_CAP = { butt: 0, round: 1, square: 2 } as const;
const LINE_JOIN = { miter: 0, round: 1, bevel: 2 } as const;
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const matrixOp = ({ a, b, c, d, e, f }: DOMMatrixReadOnly) =>
  concatTransformationMatrix(round(a), round(b), round(c), round(d), round(e), round(f));

function readColor(style: string | CanvasGradient | CanvasPattern) {
  if (typeof style !== 'string') return null;
  if (/^#[0-9a-f]{6}$/i.test(style)) {
    return { rgb: [1, 3, 5].map(offset => parseInt(style.slice(offset, offset + 2), 16) / 255), alpha: 1 };
  }
  const match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(style);
  if (!match) return null;
  return { rgb: match.slice(1, 4).map(value => Number(value) / 255), alpha: Number(match[4] ?? 1) };
}

/** Capture the same Canvas drawing the OFD engine previews. Keep its normal
 * raster output as a fallback when a page uses an unsupported paint operation. */
export class PdfCanvas {
  private commands: Command[] = [];
  private path: Segment[] = [];
  private point?: Point;
  private subpathStart?: Point;
  private complete = true;
  private imageBudget = 0;
  private immutableImages = new WeakMap<object, string>();
  readonly context: CanvasRenderingContext2D;

  constructor(private readonly canvas: CanvasRenderingContext2D) {
    const intercept = new Map<string, (args: unknown[]) => void>([
      ['save', () => this.emit(pushGraphicsState())],
      ['restore', () => this.emit(popGraphicsState())],
      ['beginPath', () => { this.path = []; this.point = undefined; this.subpathStart = undefined; }],
      ['moveTo', args => this.move(this.map(Number(args[0]), Number(args[1])))],
      ['lineTo', args => this.line(this.map(Number(args[0]), Number(args[1])))],
      ['quadraticCurveTo', args => this.quadratic(args.map(Number))],
      ['bezierCurveTo', args => {
        const [x1, y1, x2, y2, x, y] = args.map(Number);
        this.cubic(this.map(x1, y1), this.map(x2, y2), this.map(x, y));
      }],
      ['closePath', () => this.close()],
      ['rect', args => this.rect(args.map(Number))],
      ['clip', ([rule]) => {
        if (rule && typeof rule !== 'string') return this.unsupported();
        this.emit(...this.pathOperators(), rule === 'evenodd' ? clipEvenOdd() : clip(), endPath());
      }],
      ['fill', ([rule]) => {
        if (rule && typeof rule !== 'string') return this.unsupported();
        this.paint(this.path, false, rule === 'evenodd');
      }],
      ['stroke', args => { if (args.length) return this.unsupported(); this.paint(this.path, true); }],
      ['fillRect', args => this.paint(this.rectPath(args.map(Number)), false)],
      ['strokeRect', args => this.paint(this.rectPath(args.map(Number)), true)],
      ['drawImage', args => this.drawImage(args[0] as CanvasImageSource, args.slice(1).map(Number))],
    ]);
    const unsupported = new Set(['arc', 'arcTo', 'ellipse', 'roundRect', 'clearRect', 'putImageData', 'fillText', 'strokeText']);
    this.context = new Proxy(canvas, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== 'function') return value;
        const handler = typeof key === 'string' ? intercept.get(key) : undefined;
        if (!handler && !unsupported.has(String(key))) return value.bind(target);
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, target, args);
          if (this.complete) {
            try { if (handler) handler(args); else this.unsupported(); }
            catch { this.unsupported(); }
          }
          return result;
        };
      },
      set: (target, key, value) => Reflect.set(target, key, value, target),
    });
  }

  private unsupported() {
    this.complete = false;
    this.commands = [];
    this.path = [];
    this.immutableImages = new WeakMap();
  }

  private emit(...commands: Command[]) {
    if (this.commands.length + commands.length > 300_000) this.unsupported();
    if (this.complete) this.commands.push(...commands);
  }

  private map(x: number, y: number) {
    return this.canvas.getTransform().transformPoint({ x, y });
  }

  private move(point: Point) {
    this.path.push({ kind: 'm', point });
    this.point = this.subpathStart = point;
  }

  private line(point: Point) {
    if (!this.point) return this.move(point);
    this.path.push({ kind: 'l', point });
    this.point = point;
  }

  private cubic(first: Point, second: Point, end: Point) {
    if (!this.point) this.move(first);
    this.path.push({ kind: 'c', points: [first, second, end] });
    this.point = end;
  }

  private quadratic([cx, cy, x, y]: number[]) {
    const control = this.map(cx, cy), end = this.map(x, y);
    const start = this.point ?? control;
    const toward = (point: Point) => ({ x: point.x + 2 / 3 * (control.x - point.x), y: point.y + 2 / 3 * (control.y - point.y) });
    if (!this.point) this.move(control);
    this.cubic(toward(start), toward(end), end);
  }

  private close() {
    if (!this.subpathStart) return;
    this.path.push({ kind: 'h' });
    this.point = this.subpathStart;
  }

  private rectPath([x, y, w, h]: number[]): Segment[] {
    const points = [this.map(x, y), this.map(x+w, y), this.map(x+w, y+h), this.map(x, y+h)];
    return [...points.map((point, index): Segment => ({ kind: index ? 'l' : 'm', point })), { kind: 'h' }];
  }

  private rect(args: number[]) {
    const segments = this.rectPath(args);
    this.path.push(...segments);
    const start = segments[0];
    if (start.kind === 'm') this.point = this.subpathStart = start.point;
  }

  private pathOperators(path = this.path, inverse?: DOMMatrix) {
    const coords = (point: Point): [number, number] => {
      const transformed = inverse?.transformPoint(point) ?? point;
      return [round(transformed.x), round(transformed.y)];
    };
    return path.map(segment => {
      switch (segment.kind) {
        case 'm': return moveTo(...coords(segment.point));
        case 'l': return lineTo(...coords(segment.point));
        case 'c': return appendBezierCurve(...coords(segment.points[0]), ...coords(segment.points[1]), ...coords(segment.points[2]));
        case 'h': return closePath();
      }
    });
  }

  private paint(path: Segment[], outlined: boolean, evenOdd = false) {
    if (!path.length) return;
    const ctx = this.canvas;
    const color = readColor(outlined ? ctx.strokeStyle : ctx.fillStyle);
    const composite = BLENDS.get(ctx.globalCompositeOperation);
    if (!color || !composite) return this.unsupported();
    const [r, g, b] = color.rgb;
    this.emit(pushGraphicsState(), { alpha: ctx.globalAlpha * color.alpha, composite });
    if (outlined) {
      const matrix = ctx.getTransform();
      const inverse = matrix.inverse();
      if (!Number.isFinite(inverse.a)) return this.unsupported();
      this.emit(matrixOp(matrix), setStrokingRgbColor(r, g, b), setLineWidth(ctx.lineWidth),
        setLineCap(LINE_CAP[ctx.lineCap]), setLineJoin(LINE_JOIN[ctx.lineJoin]),
        PDFOperator.of(PDFOperatorNames.SetLineMiterLimit, [PDFNumber.of(ctx.miterLimit)]),
        setDashPattern(ctx.getLineDash(), ctx.lineDashOffset));
      this.emit(...this.pathOperators(path, inverse), stroke());
    } else {
      this.emit(setFillingRgbColor(r, g, b), ...this.pathOperators(path),
        evenOdd ? PDFOperator.of(PDFOperatorNames.FillEvenOdd) : fill());
    }
    this.emit(popGraphicsState());
  }

  private drawImage(source: CanvasImageSource, args: number[]) {
    const composite = BLENDS.get(this.canvas.globalCompositeOperation);
    if (!composite || ![2, 4, 8].includes(args.length)) return this.unsupported();
    const dimensions = source as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number };
    const sourceWidth = dimensions.naturalWidth || dimensions.width || 0;
    const sourceHeight = dimensions.naturalHeight || dimensions.height || 0;
    const cropped = args.length === 8;
    const [sx, sy, sw, sh] = cropped ? args : [0, 0, sourceWidth, sourceHeight];
    const [x, y, width = sw, height = sh] = cropped ? args.slice(4) : args;
    if (![sw, sh, width, height].every(value => value > 0)) return this.unsupported();
    // Capture mutable scratch canvases now, before the OFD renderer reuses them.
    const immutable = !cropped && ((typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) ||
      source instanceof HTMLImageElement);
    let png = immutable ? this.immutableImages.get(source) : undefined;
    if (!png) {
      const snapshot = document.createElement('canvas');
      snapshot.width = Math.ceil(sw);
      snapshot.height = Math.ceil(sh);
      try {
        snapshot.getContext('2d')!.drawImage(source, sx, sy, sw, sh, 0, 0, snapshot.width, snapshot.height);
        png = snapshot.toDataURL('image/png');
      } finally {
        snapshot.width = snapshot.height = 1;
      }
      this.imageBudget += png.length;
      if (png === 'data:,' || this.imageBudget > 48 * 1024 * 1024) return this.unsupported();
      if (immutable) this.immutableImages.set(source, png);
    }
    this.emit(pushGraphicsState(), { alpha: this.canvas.globalAlpha, composite },
      matrixOp(this.canvas.getTransform()), concatTransformationMatrix(width, 0, 0, -height, x, y+height),
      { png }, popGraphicsState());
  }

  async write(pdf: PDFDocument, page: PDFPage, pointsPerPixel: number, signal: AbortSignal): Promise<number | null> {
    if (!this.complete || !this.commands.length) return null;
    const images = new Map<string, PDFName>();
    const states = new Map<string, PDFName>();
    const ops = [pushGraphicsState(), concatTransformationMatrix(pointsPerPixel, 0, 0, -pointsPerPixel, 0, page.getHeight())];
    let embeddedBytes = 0;
    for (const command of this.commands) {
      if (command instanceof PDFOperator) {
        ops.push(command);
      } else if ('png' in command) {
        cancelled(signal);
        let name = images.get(command.png);
        if (!name) {
          const image = await pdf.embedPng(command.png);
          name = page.node.newXObject('OfdImage', image.ref);
          images.set(command.png, name);
          embeddedBytes += Math.ceil(command.png.length * .75);
        }
        ops.push(drawObject(name));
      } else if (command.alpha !== 1 || command.composite !== 'Normal') {
        const key = `${command.composite}:${round(command.alpha)}`;
        let name = states.get(key);
        if (!name) {
          name = page.node.newExtGState('OfdPaint', pdf.context.obj({
            Type: 'ExtGState', ca: command.alpha, CA: command.alpha, BM: command.composite,
          }));
          states.set(key, name);
        }
        ops.push(setGraphicsState(name));
      }
    }
    ops.push(popGraphicsState());
    for (let i = 0; i < ops.length; i += 1000) page.pushOperators(...ops.slice(i, i+1000));
    return embeddedBytes;
  }
}
