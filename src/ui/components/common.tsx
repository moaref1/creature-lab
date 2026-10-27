// Shared UI pieces: panel frame, popup menus, canvas charts, hooks for live sources.
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Icon } from '../icons/icons';
import { sim } from '../sim/controller';
import { trainer } from '../train/manager';
import { formatNum } from '../../core/util';

export function Panel({ actions, children, flush, sub }: { title?: string; icon?: string; actions?: React.ReactNode; children: React.ReactNode; flush?: boolean; sub?: React.ReactNode }) {
  return (
    <div className="panel">
      {(sub || actions) && (
        <div className="panel-head">
          {sub && <span className="muted ellipsis" style={{ fontSize: 11.5 }}>{sub}</span>}
          <span className="grow" />
          {actions}
        </div>
      )}
      <div className={`panel-body ${flush ? 'flush' : ''}`}>{children}</div>
    </div>
  );
}

export function Empty({ icon = 'info', children }: { icon?: string; children: React.ReactNode }) {
  return (
    <div className="empty">
      <div>
        <Icon name={icon} size={26} />
      </div>
      {children}
    </div>
  );
}

// ---------- live subscriptions ----------
const simSub = (cb: () => void) => sim.subscribe(cb);
let simTick = 0;
sim.subscribe(() => simTick++);
export function useSim() {
  return useSyncExternalStore(simSub, () => simTick);
}
let trainTick = 0;
trainer.subscribe(() => trainTick++);
export function useTrainer() {
  return useSyncExternalStore((cb) => trainer.subscribe(cb), () => trainTick);
}
/** Re-render at most every `ms` while a source keeps ticking (cheap live panels). */
export function useThrottledSim(ms = 100) {
  const [, set] = useState(0);
  useEffect(() => {
    let last = 0;
    let timer: any = null;
    const off = sim.subscribe(() => {
      const now = performance.now();
      if (now - last > ms) {
        last = now;
        set((x) => x + 1);
      } else if (!timer)
        timer = setTimeout(() => {
          timer = null;
          last = performance.now();
          set((x) => x + 1);
        }, ms);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [ms]);
}

// ---------- menus ----------
export interface MenuItem {
  label: string;
  icon?: string;
  desc?: string;
  color?: string;
  group?: string;
  disabled?: boolean;
  run: () => void;
}

let openMenu: ((m: { x: number; y: number; items: MenuItem[]; search?: boolean } | null) => void) | null = null;
export function showMenu(e: { clientX: number; clientY: number } | DOMRect, items: MenuItem[], search = items.length > 10) {
  const x = 'clientX' in e ? e.clientX : e.left;
  const y = 'clientY' in e ? e.clientY : e.bottom + 4;
  openMenu?.({ x, y, items, search });
}

export function MenuHost() {
  const [m, setM] = useState<{ x: number; y: number; items: MenuItem[]; search?: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    openMenu = (x) => {
      setM(x);
      setQ('');
      setActive(0);
    };
  }, []);
  const filtered = useMemo(() => (m ? m.items.filter((i) => !q || (i.label + ' ' + (i.desc ?? '') + ' ' + (i.group ?? '')).toLowerCase().includes(q.toLowerCase())) : []), [m, q]);
  useLayoutEffect(() => {
    if (!m || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // open upward when there is no room below
    const below = window.innerHeight - m.y - 8;
    const y = r.height <= below ? m.y : Math.max(4, Math.min(m.y - r.height, window.innerHeight - r.height - 8));
    setPos({ x: Math.max(4, Math.min(m.x, window.innerWidth - r.width - 8)), y });
  }, [m, filtered.length]);
  useEffect(() => {
    if (!m) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setM(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setM(null);
      if (e.key === 'ArrowDown') setActive((a) => Math.min(filtered.length - 1, a + 1));
      if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
      if (e.key === 'Enter' && filtered[active] && !filtered[active].disabled) {
        filtered[active].run();
        setM(null);
      }
    };
    setTimeout(() => window.addEventListener('mousedown', close), 0);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [m, filtered, active]);
  if (!m) return null;
  let lastGroup: string | undefined;
  return (
    <div ref={ref} className={`menu ${m.search ? 'menu-search' : ''}`} style={{ left: pos.x, top: pos.y }}>
      {m.search && <input autoFocus className="input" placeholder="Search…" value={q} onChange={(e) => (setQ(e.target.value), setActive(0))} />}
      <div className="menu-list">
      {filtered.map((it, i) => {
        const g = it.group !== lastGroup ? it.group : undefined;
        lastGroup = it.group;
        return (
          <React.Fragment key={i}>
            {g && <div className="menu-group">{g}</div>}
            <div
              className={`menu-item ${i === active ? 'active' : ''}`}
              ref={
                i === active
                  ? (el) => {
                      // keep the highlighted row visible inside the list only (never scroll the page)
                      const list = el?.parentElement;
                      if (!el || !list) return;
                      if (el.offsetTop < list.scrollTop) list.scrollTop = el.offsetTop - 24;
                      else if (el.offsetTop + el.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = el.offsetTop + el.offsetHeight - list.clientHeight;
                    }
                  : undefined
              }
              title={m.search ? it.desc : undefined}
              style={it.disabled ? { opacity: 0.4, cursor: 'default' } : undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => {
                if (it.disabled) return;
                it.run();
                setM(null);
              }}
            >
              {it.color && <span className="stripe" style={{ background: it.color }} />}
              {it.icon && <Icon name={it.icon} size={14} />}
              <span>{it.label}</span>
              {it.desc && !m.search && <span className="desc">{it.desc}</span>}
            </div>
          </React.Fragment>
        );
      })}
      {!filtered.length && <div className="menu-item muted">No matches</div>}
      </div>
      {m.search && filtered[active]?.desc && <div className="menu-desc">{filtered[active].desc}</div>}
    </div>
  );
}

// ---------- charts ----------
export interface Series {
  name: string;
  color: string;
  values: number[];
  dashed?: boolean;
}
export const SERIES_COLORS = ['#2dd4bf', '#f0b429', '#ef6b73', '#7c8cf8', '#5fd38d', '#f472b6', '#a78bfa', '#60a5fa', '#fb923c', '#94a3b8'];

export function LineChart({ x, series, height = 160, markers = [], xLabel, yFormat, hidden, smooth = 0 }: { x: number[]; series: Series[]; height?: number; markers?: { x: number; label: string; color?: string }[]; xLabel?: (v: number) => string; yFormat?: (v: number) => string; hidden?: Set<string>; smooth?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [w, setW] = useState(300);
  useEffect(() => {
    const el = ref.current!.parentElement!;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const shown = series.filter((s) => !hidden?.has(s.name));
  const smoothed = useMemo(
    () =>
      shown.map((s) => {
        if (!smooth) return s.values;
        const out: number[] = [];
        let e = s.values[0] ?? 0;
        for (const v of s.values) out.push((e = e * smooth + v * (1 - smooth)));
        return out;
      }),
    [shown, smooth],
  );
  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr;
    c.height = height * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, height);
    const padL = 44,
      padR = 8,
      padT = 8,
      padB = 18;
    const all = smoothed.flat().filter(Number.isFinite);
    if (!x.length || !all.length) {
      g.fillStyle = '#6f7a88';
      g.font = '11px Inter, sans-serif';
      g.fillText('Waiting for data…', padL, height / 2);
      return;
    }
    let lo = Math.min(...all),
      hi = Math.max(...all);
    if (hi - lo < 1e-9) {
      lo -= 1;
      hi += 1;
    }
    const pad = (hi - lo) * 0.08;
    lo -= pad;
    hi += pad;
    const x0 = x[0],
      x1 = x[x.length - 1] || 1;
    const X = (v: number) => padL + ((v - x0) / Math.max(1e-9, x1 - x0)) * (w - padL - padR);
    const Y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
    g.strokeStyle = '#232830';
    g.fillStyle = '#6f7a88';
    g.font = '10px JetBrains Mono, Consolas, monospace';
    g.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      const y = Y(v);
      g.beginPath();
      g.moveTo(padL, y);
      g.lineTo(w - padR, y);
      g.stroke();
      g.fillText(yFormat ? yFormat(v) : formatNum(v), 2, y + 3);
    }
    if (lo < 0 && hi > 0) {
      g.strokeStyle = '#3a414c';
      g.beginPath();
      g.moveTo(padL, Y(0));
      g.lineTo(w - padR, Y(0));
      g.stroke();
    }
    g.fillText(xLabel ? xLabel(x0) : formatNum(x0), padL, height - 4);
    const r = xLabel ? xLabel(x1) : formatNum(x1);
    g.fillText(r, w - padR - g.measureText(r).width, height - 4);
    for (const m of markers) {
      const xx = X(m.x);
      g.strokeStyle = m.color ?? '#f0b429';
      g.setLineDash([3, 3]);
      g.beginPath();
      g.moveTo(xx, padT);
      g.lineTo(xx, height - padB);
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = m.color ?? '#f0b429';
      g.fillText(m.label, xx + 3, padT + 9);
    }
    shown.forEach((s, si) => {
      const vals = smoothed[si];
      g.strokeStyle = s.color;
      g.lineWidth = 1.6;
      g.setLineDash(s.dashed ? [4, 3] : []);
      g.beginPath();
      let started = false;
      for (let i = 0; i < vals.length && i < x.length; i++) {
        if (!Number.isFinite(vals[i])) continue;
        const px = X(x[i]),
          py = Y(vals[i]);
        if (!started) g.moveTo(px, py);
        else g.lineTo(px, py);
        started = true;
      }
      g.stroke();
      g.setLineDash([]);
    });
    if (hover !== null && hover < x.length) {
      const hx = X(x[hover]);
      g.strokeStyle = '#4b5563';
      g.beginPath();
      g.moveTo(hx, padT);
      g.lineTo(hx, height - padB);
      g.stroke();
      shown.forEach((s, si) => {
        const v = smoothed[si][hover];
        if (!Number.isFinite(v)) return;
        g.fillStyle = s.color;
        g.beginPath();
        g.arc(hx, Y(v), 3, 0, Math.PI * 2);
        g.fill();
      });
    }
  }, [x, smoothed, w, height, markers, hover]);
  const onMove = (e: React.MouseEvent) => {
    if (!x.length) return;
    const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const f = (e.clientX - r.left - 44) / (r.width - 52);
    setHover(Math.max(0, Math.min(x.length - 1, Math.round(f * (x.length - 1)))));
  };
  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <canvas ref={ref} style={{ width: '100%', height, display: 'block' }} onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      {hover !== null && x[hover] !== undefined && (
        <div className="tip" style={{ position: 'absolute', left: 50, top: 6 }}>
          <div className="mono muted">{xLabel ? xLabel(x[hover]) : formatNum(x[hover])}</div>
          {shown.map((s, si) => (
            <div key={s.name} className="row" style={{ gap: 6 }}>
              <span className="swatch" style={{ background: s.color }} />
              <span className="grow">{s.name}</span>
              <span className="mono">{formatNum(smoothed[si][hover] ?? NaN, 3)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ series, hidden, toggle }: { series: Series[]; hidden: Set<string>; toggle: (n: string) => void }) {
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.name} className={hidden.has(s.name) ? 'off' : ''} onClick={() => toggle(s.name)}>
          <i style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

export function Sparkline({ values, color = '#2dd4bf', height = 22, width = 110 }: { values: number[]; color?: string; height?: number; width?: number }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  let lo = Math.min(...values),
    hi = Math.max(...values);
  if (hi - lo < 1e-9) {
    lo -= 1;
    hi += 1;
  }
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - lo) / (hi - lo)) * (height - 4)).toFixed(1)}`).join(' ');
  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function Kpi({ k, v, tone }: { k: string; v: React.ReactNode; tone?: string }) {
  return (
    <div className="kpi">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`}>{v}</div>
    </div>
  );
}

export function Modal({ title, icon, onClose, children, foot, width }: { title: string; icon?: string; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">
          {icon && <Icon name={icon} size={18} className="accent" />}
          <h2>{title}</h2>
          <span className="grow" />
          <button className="iconbtn" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function Select<T extends string>({ value, options, onChange, style }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; style?: React.CSSProperties }) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)} style={style}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
