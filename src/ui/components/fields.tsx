// Generic editors for FieldDef-described data. Every Properties view in the studio is
// built from these, so user-defined components get the same UI as built-ins.
import React, { useEffect, useRef, useState } from 'react';
import type { FieldDef, Randomization } from '../../core/schema';
import { defaultFor, fieldLabel, optionValues, withDefaults } from '../../core/schema';
import { Icon } from '../icons/icons';
import { useDoc } from '../store';
import { allComponentDefs } from '../../core/sim/resolve';

const AXES = ['X', 'Y', 'Z'];
const AXIS_COLORS = ['#ef6b73', '#5fd38d', '#7c8cf8'];

export function fmt(v: number, step?: number) {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  const d = step !== undefined && step < 1 ? Math.min(6, Math.max(0, Math.ceil(-Math.log10(step)))) : a >= 100 ? 1 : a >= 10 ? 2 : 3;
  return v.toFixed(d);
}

/** Value field that is also a slider: drag to change, click to type. Dashed band = random range. */
export function ValueSlider(props: {
  value: number;
  onChange: (v: number, done: boolean) => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  int?: boolean;
  band?: { min: number; max: number } | null;
  axis?: number;
  disabled?: boolean;
}) {
  const { value, min, max, unit, int, band, axis } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const bounded = min !== undefined && max !== undefined && isFinite(min) && isFinite(max) && max > min;
  const frac = bounded ? Math.max(0, Math.min(1, (value - min!) / (max! - min!))) : 0;
  const step = props.step ?? (int ? 1 : bounded ? (max! - min!) / 1000 : 0.01);
  const clampV = (v: number) => {
    if (min !== undefined && isFinite(min)) v = Math.max(min, v);
    if (max !== undefined && isFinite(max)) v = Math.min(max, v);
    return int ? Math.round(v) : v;
  };
  const onDown = (e: React.PointerEvent) => {
    if (props.disabled || editing) return;
    const el = ref.current!;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startV = value;
    const w = el.clientWidth;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 2) moved = true;
      if (!moved) return;
      const fine = ev.shiftKey ? 0.1 : 1;
      let v: number;
      if (bounded) v = startV + (dx / w) * (max! - min!) * fine;
      else v = startV + dx * (Math.abs(startV) > 10 ? Math.abs(startV) * 0.01 : step * 2) * fine;
      if (ev.ctrlKey && step) v = Math.round(v / (step * 10)) * step * 10;
      props.onChange(clampV(v), false);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      if (!moved) {
        setText(String(+value.toFixed(6)));
        setEditing(true);
      } else props.onChange(clampV(value), true);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const commit = () => {
    setEditing(false);
    // allow simple expressions like "2*3"
    let v = Number(text);
    if (!isFinite(v)) {
      try {
        if (/^[\d+\-*/.() e]+$/.test(text)) v = Function(`"use strict";return (${text})`)();
      } catch {
        v = value;
      }
    }
    if (isFinite(v)) props.onChange(clampV(v), true);
  };
  return (
    <div ref={ref} className="vslider" onPointerDown={onDown} style={props.disabled ? { opacity: 0.5, cursor: 'default' } : undefined} title="Drag to change · Shift for fine · click to type">
      {bounded && <div className="fill" style={{ width: `${frac * 100}%` }} />}
      {bounded && band && (
        <div className="band" style={{ left: `${Math.max(0, ((band.min - min!) / (max! - min!)) * 100)}%`, width: `${Math.max(1, ((band.max - band.min) / (max! - min!)) * 100)}%` }} title={`Randomised ${fmt(band.min)} – ${fmt(band.max)}`} />
      )}
      {axis !== undefined && <span className="axis" style={{ color: AXIS_COLORS[axis] }}>{AXES[axis]}</span>}
      {editing ? (
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => (e.key === 'Enter' ? commit() : e.key === 'Escape' ? setEditing(false) : null)} />
      ) : (
        <div className="val" style={axis !== undefined ? { paddingLeft: 18 } : undefined}>
          <span>{int ? Math.round(value) : fmt(value, props.step)}</span>
          {unit && <span className="unit">{unit}</span>}
        </div>
      )}
    </div>
  );
}

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <div className={`toggle ${on ? 'on' : ''}`} onClick={() => onChange(!on)} title={title} role="switch" aria-checked={on} />;
}

export function TagsEditor({ value, onChange, placeholder, suggestions }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; suggestions?: string[] }) {
  const [t, setT] = useState('');
  const add = () => {
    const v = t.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setT('');
  };
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      {value.map((x) => (
        <span key={x} className="chip">
          {x}
          <span className="x" onClick={() => onChange(value.filter((y) => y !== x))}>
            <Icon name="x" size={11} />
          </span>
        </span>
      ))}
      <input
        className="input"
        style={{ width: 90, height: 20, flex: 1, minWidth: 60 }}
        value={t}
        list={suggestions ? 'tag-suggest' : undefined}
        placeholder={placeholder ?? 'add…'}
        onChange={(e) => setT(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !t && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={add}
      />
      {suggestions && (
        <datalist id="tag-suggest">
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  );
}

function RefSelect({ f, value, onChange }: { f: FieldDef; value: string; onChange: (v: string) => void }) {
  const project = useDoc();
  let opts: { id: string; name: string }[] = [];
  if (project) {
    switch (f.refKind) {
      case 'prefab':
        opts = project.prefabs;
        break;
      case 'brain':
        opts = project.brains;
        break;
      case 'graph':
        opts = project.graphs;
        break;
      case 'scenario':
        opts = project.scenarios;
        break;
      case 'world':
        opts = project.worlds;
        break;
      case 'asset':
        opts = project.assets;
        break;
      case 'object':
        opts = project.worlds.flatMap((w) => w.objects);
        break;
      case 'componentDef':
        opts = allComponentDefs(project).filter((c) => c.role === 'data' || true).map((c) => ({ id: c.id, name: `${c.name}` }));
        break;
    }
  }
  return (
    <select className="select" value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      <option value="">—</option>
      {opts.map((o) => (
        <option key={o.id} value={o.id}>
          {o.name}
        </option>
      ))}
      {value && !opts.some((o) => o.id === value) && <option value={value}>{value} (missing)</option>}
    </select>
  );
}

function JsonField({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const [t, setT] = useState(() => JSON.stringify(value, null, 1));
  const [err, setErr] = useState('');
  useEffect(() => setT(JSON.stringify(value, null, 1)), [JSON.stringify(value)]);
  return (
    <div className="col" style={{ gap: 2 }}>
      <textarea
        className="textarea"
        value={t}
        spellCheck={false}
        onChange={(e) => {
          setT(e.target.value);
          try {
            JSON.parse(e.target.value);
            setErr('');
          } catch (er: any) {
            setErr(er.message);
          }
        }}
        onBlur={() => {
          try {
            onChange(JSON.parse(t));
          } catch {
            /* keep text */
          }
        }}
        style={{ minHeight: 60 }}
      />
      {err && <span className="bad" style={{ fontSize: 11 }}>{err}</span>}
    </div>
  );
}

export interface FieldCtx {
  /** randomisation path for a key, when the value can be randomised during training */
  randPath?: (key: string) => string | null;
  rand?: Record<string, Randomization>;
  onRand?: (path: string, r: Randomization | null) => void;
  coalesce?: string;
}

export function FieldEditor({ f, value, onChange, ctx }: { f: FieldDef; value: any; onChange: (v: any, done?: boolean) => void; ctx?: FieldCtx }) {
  const v = value === undefined ? defaultFor(f) : value;
  switch (f.type) {
    case 'float':
    case 'int': {
      const path = f.randomizable && ctx?.randPath ? ctx.randPath(f.key) : null;
      const r = path ? ctx?.rand?.[path] : undefined;
      return (
        <div className="row" style={{ gap: 4 }}>
          <div className="grow">
            <ValueSlider value={Number(v)} min={f.min} max={f.max} step={f.step} unit={f.unit} int={f.type === 'int'} band={r ?? null} onChange={(x, done) => onChange(x, done)} disabled={f.readonly} />
          </div>
          {path && (
            <button
              className={`iconbtn small rand-btn ${r ? 'on' : ''}`}
              title={r ? `Randomised during training ${fmt(r.min)}–${fmt(r.max)} (click to remove)` : 'Randomise during training (domain randomisation)'}
              onClick={() => {
                if (r) ctx!.onRand!(path, null);
                else {
                  const span = f.max !== undefined && f.min !== undefined ? (f.max - f.min) * 0.1 : Math.abs(Number(v)) * 0.2 || 0.1;
                  ctx!.onRand!(path, { min: Math.max(f.min ?? -Infinity, Number(v) - span), max: Math.min(f.max ?? Infinity, Number(v) + span), dist: 'uniform' });
                }
              }}
            >
              <Icon name="dice" size={14} />
            </button>
          )}
        </div>
      );
    }
    case 'bool':
      return <Toggle on={!!v} onChange={(x) => onChange(x, true)} />;
    case 'vec2':
    case 'vec3': {
      const n = f.type === 'vec2' ? 2 : 3;
      const arr: number[] = Array.isArray(v) ? v : new Array(n).fill(0);
      return (
        <div className={`vec n${n}`}>
          {Array.from({ length: n }, (_, i) => (
            <ValueSlider key={i} axis={i} value={Number(arr[i] ?? 0)} step={f.step ?? 0.01} onChange={(x, done) => onChange(arr.map((y, j) => (j === i ? +x.toFixed(4) : y)), done)} disabled={f.readonly} />
          ))}
        </div>
      );
    }
    case 'enum':
      return (
        <select className="select" value={v} onChange={(e) => onChange(e.target.value, true)}>
          {(f.options ?? []).map((o: any) => {
            const val = typeof o === 'string' ? o : o.value;
            return (
              <option key={val} value={val}>
                {typeof o === 'string' ? o : o.label ?? o.value}
              </option>
            );
          })}
        </select>
      );
    case 'color':
      return (
        <div className="row" style={{ gap: 6 }}>
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(v) ? v : '#888888'} onChange={(e) => onChange(e.target.value, false)} onBlur={(e) => onChange(e.target.value, true)} style={{ width: 28, height: 22, border: 0, background: 'none', padding: 0 }} />
          <input className="input mono" value={v} onChange={(e) => onChange(e.target.value, true)} />
        </div>
      );
    case 'tags':
      return <TagsEditor value={Array.isArray(v) ? v : []} onChange={(x) => onChange(x, true)} />;
    case 'ref':
      return <RefSelect f={f} value={v} onChange={(x) => onChange(x, true)} />;
    case 'text':
    case 'code':
      return <textarea className={`textarea ${f.type === 'code' ? 'code' : ''}`} value={v} spellCheck={false} onChange={(e) => onChange(e.target.value, false)} onBlur={(e) => onChange(e.target.value, true)} />;
    case 'list':
      return <ListEditor f={f} value={Array.isArray(v) ? v : []} onChange={onChange} ctx={ctx} />;
    case 'map': {
      const entries = Object.entries(v ?? {});
      return entries.length ? (
        <div className="col" style={{ gap: 2 }}>
          {entries.map(([k, x]) => (
            <div key={k} className="bar-row" style={{ gridTemplateColumns: '1fr 1fr 44px' }}>
              <span className="name">{k}</span>
              <div className="hbar center">
                <i style={{ left: `${50 + Math.min(0, Number(x)) * 50}%`, width: `${Math.abs(Number(x)) * 50}%` }} />
              </div>
              <span className="mono">{fmt(Number(x))}</span>
            </div>
          ))}
        </div>
      ) : (
        <span className="muted">empty — filled while the simulation runs</span>
      );
    }
    case 'json':
      return <JsonField value={v} onChange={(x) => onChange(x, true)} />;
    default:
      return <input className="input" value={v ?? ''} readOnly={f.readonly} onChange={(e) => onChange(e.target.value, false)} onBlur={(e) => onChange(e.target.value, true)} />;
  }
}

function ListEditor({ f, value, onChange, ctx }: { f: FieldDef; value: any[]; onChange: (v: any, done?: boolean) => void; ctx?: FieldCtx }) {
  const [open, setOpen] = useState<number | null>(value.length <= 2 ? 0 : null);
  const items = f.itemFields ?? [];
  const title = (it: any, i: number) => it?.name ?? it?.label ?? it?.field ?? (Array.isArray(it?.p) ? it.p.map((x: number) => x.toFixed(1)).join(', ') : `#${i + 1}`);
  return (
    <div className="list-field">
      {value.map((it, i) => (
        <div key={i} className="list-item">
          <div className="list-item-head" onClick={() => setOpen(open === i ? null : i)}>
            <Icon name={open === i ? 'chevron-down' : 'chevron-right'} size={12} />
            <span className="grow ellipsis">{title(it, i)}</span>
            <button
              className="iconbtn small"
              title="Duplicate"
              onClick={(e) => {
                e.stopPropagation();
                onChange([...value.slice(0, i + 1), JSON.parse(JSON.stringify(it)), ...value.slice(i + 1)], true);
              }}
            >
              <Icon name="copy" size={12} />
            </button>
            <button
              className="iconbtn small"
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                onChange(value.filter((_, j) => j !== i), true);
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
          {open === i && (
            <div style={{ marginTop: 6 }}>
              <FieldList fields={items} values={it} onChange={(k, x, done) => onChange(value.map((y, j) => (j === i ? { ...y, [k]: x } : y)), done)} ctx={{ ...ctx, randPath: undefined }} />
            </div>
          )}
        </div>
      ))}
      <div
        className="add-row"
        onClick={() => {
          onChange([...value, withDefaults(items, {})], true);
          setOpen(value.length);
        }}
      >
        <Icon name="plus" size={13} /> Add {f.label ?? f.key.replace(/s$/, '')}
      </div>
    </div>
  );
}

export function FieldList({ fields, values, onChange, ctx, filter }: { fields: FieldDef[]; values: Record<string, any>; onChange: (key: string, v: any, done?: boolean) => void; ctx?: FieldCtx; filter?: string }) {
  const visible = fields.filter((f) => {
    if (f.showIf && values?.[f.showIf.key] !== f.showIf.equals) return false;
    if (filter && !fieldLabel(f).toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });
  return (
    <>
      {visible.map((f) => {
        const wide = f.type === 'list' || f.type === 'code' || f.type === 'text' || f.type === 'json' || f.type === 'map';
        return (
          <div key={f.key} className={`field ${wide ? 'stack' : ''}`} title={f.help}>
            <label>
              {fieldLabel(f)}
              {f.help && wide && <span className="muted"> · {f.help}</span>}
            </label>
            <FieldEditor f={f} value={values?.[f.key]} onChange={(v, done) => onChange(f.key, v, done)} ctx={ctx} />
          </div>
        );
      })}
    </>
  );
}

export { optionValues };
