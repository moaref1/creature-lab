// Hardware detection for the workers panel and auto-tune.
let cached: { renderer: string; short: string; webgpu: boolean } | null = null;

export function gpuInfo() {
  if (cached) return cached;
  let renderer = 'unknown GPU';
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }
  } catch {
    /* no GPU info */
  }
  const m = /(RTX|GTX|RX|Arc|Radeon|Iris|UHD|Apple M\d|GeForce)[^,()]*/i.exec(renderer);
  cached = { renderer, short: (m?.[0] ?? renderer).replace(/\s+/g, ' ').trim().slice(0, 28), webgpu: typeof navigator !== 'undefined' && 'gpu' in navigator };
  return cached;
}
