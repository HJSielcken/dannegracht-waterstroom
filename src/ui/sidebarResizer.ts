const STORAGE_KEY = 'sidebar-width';
const MIN_WIDTH = 260;
const MAX_FRACTION = 0.7;
const KEY_STEP = 20;

/**
 * Let the user drag `handle` to change the sidebar width. The width lives in the
 * `--sidebar-width` custom property on the document root and is remembered across visits.
 */
export function initSidebarResizer(handle: HTMLElement, onResize: () => void): void {
  const root = document.documentElement;
  const clamp = (w: number) =>
    Math.round(Math.min(Math.max(w, MIN_WIDTH), window.innerWidth * MAX_FRACTION));
  const current = () => parseFloat(getComputedStyle(root).getPropertyValue('--sidebar-width'));
  const apply = (w: number) => {
    root.style.setProperty('--sidebar-width', `${clamp(w)}px`);
    onResize();
  };

  const saved = Number(localStorage.getItem(STORAGE_KEY));
  if (saved > 0) apply(saved);

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const move = (ev: PointerEvent) => apply(ev.clientX);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      document.body.classList.remove('resizing');
      localStorage.setItem(STORAGE_KEY, String(current()));
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up, { once: true });
    handle.addEventListener('pointercancel', up, { once: true });
  });

  handle.addEventListener('dblclick', () => {
    root.style.removeProperty('--sidebar-width');
    localStorage.removeItem(STORAGE_KEY);
    onResize();
  });

  handle.addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' ? -KEY_STEP : e.key === 'ArrowRight' ? KEY_STEP : 0;
    if (!step) return;
    e.preventDefault();
    apply(current() + step);
    localStorage.setItem(STORAGE_KEY, String(current()));
  });

  window.addEventListener('resize', () => {
    if (root.style.getPropertyValue('--sidebar-width')) apply(current());
  });
}
