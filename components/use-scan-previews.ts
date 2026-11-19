import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { ScanWorker, renderScan, type ScanPhoto } from '../lib/scanner/client';

export const scanPreviewKey = (photo: ScanPhoto) => JSON.stringify([photo.points, photo.settings]);
type Failure = { key: string; message: string };

// One worker and one in-flight render for all pages. Intermediate slider values
// are coalesced; a completed preview never marks newer settings as ready.
export function useScanPreviews(photos: ScanPhoto[], setPhotos: Dispatch<SetStateAction<ScanPhoto[]>>, enabled: boolean) {
  const [worker] = useState(() => new ScanWorker());
  const [rendering, setRendering] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  const [generation, setGeneration] = useState(0);
  const job = useRef<{ controller: AbortController; id: string } | null>(null);
  const scheduled = useRef<{ id: string; at: number } | null>(null);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; job.current?.controller.abort(); worker.dispose(); };
  }, [worker]);

  useEffect(() => {
    if (!enabled) {
      scheduled.current = null;
      job.current?.controller.abort();
      worker.dispose();
      return;
    }
    if (job.current) {
      if (!photos.some(p => p.id === job.current!.id)) job.current.controller.abort();
      return;
    }
    const photo = photos.find(p => (p.dirty || !p.result) && failures[p.id]?.key !== scanPreviewKey(p));
    if (!photo) { scheduled.current = null; return; }
    if (scheduled.current?.id !== photo.id) scheduled.current = { id: photo.id, at: performance.now() };
    // A short throttle, rather than a trailing debounce: preview still advances
    // while a slider or corner is being dragged continuously.
    const delay = Math.max(0, 100 - (performance.now() - scheduled.current.at));
    const timer = window.setTimeout(() => {
      scheduled.current = null;
      const current = { controller: new AbortController(), id: photo.id };
      const key = scanPreviewKey(photo);
      job.current = current;
      setRendering(photo.id);
      void renderScan(photo, worker, 1200, () => {}, current.controller.signal, .94, true).then(result => {
        if (!mounted.current || current.controller.signal.aborted) return;
        setPhotos(previous => previous.map(p => p.id === photo.id
          ? { ...p, result, dirty: scanPreviewKey(p) !== key } : p));
      }).catch(error => {
        if (!mounted.current || current.controller.signal.aborted) return;
        worker.dispose();
        setFailures(previous => ({ ...previous, [photo.id]: { key, message: error instanceof Error ? error.message : '扫描预览生成失败，请重试。' } }));
      }).finally(() => {
        if (job.current === current) job.current = null;
        if (mounted.current) { setRendering(null); setGeneration(value => value + 1); }
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [photos, setPhotos, enabled, failures, generation, worker]);

  function retry(id: string) {
    setFailures(previous => { const next = { ...previous }; delete next[id]; return next; });
  }
  return { rendering, failures, retry };
}
