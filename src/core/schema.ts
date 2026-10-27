// Typed fields: the one way the studio describes data. Components, sensors, actuators,
// node parameters, trainer settings and exporter options all use FieldDef, so the
// Properties panel can edit anything without custom UI.
import { Rng, clamp } from './util';

export type FieldType =
  | 'float'
  | 'int'
  | 'bool'
  | 'vec2'
  | 'vec3'
  | 'enum'
  | 'string'
  | 'text'
  | 'code'
  | 'color'
  | 'tags'
  | 'ref' // reference to a project item (prefab, brain, graph, object, component def…)
  | 'list' // list of records described by itemFields
  | 'map' // string -> number map (e.g. Bond: feelings toward other entities)
  | 'json';

export interface FieldDef {
  key: string;
  type: FieldType;
  label?: string;
  default?: any;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: { value: string; label?: string }[] | string[];
  /** For 'ref': which project collection it points at. */
  refKind?: 'prefab' | 'brain' | 'graph' | 'object' | 'componentDef' | 'scenario' | 'world' | 'asset' | 'tag' | 'field';
  itemFields?: FieldDef[];
  help?: string;
  /** Hide in the UI unless this predicate (evaluated on sibling values) holds. */
  showIf?: { key: string; equals: any };
  group?: string;
  /** Whether training can randomise this value (shown as a band on the slider). */
  randomizable?: boolean;
  readonly?: boolean;
}

export interface Randomization {
  min: number;
  max: number;
  dist: 'uniform' | 'normal';
}

export function optionValues(f: FieldDef): string[] {
  return (f.options ?? []).map((o: any) => (typeof o === 'string' ? o : o.value));
}

export function defaultFor(f: FieldDef): any {
  if (f.default !== undefined) return structuredCloneSafe(f.default);
  switch (f.type) {
    case 'float':
    case 'int':
      return f.min !== undefined && f.min > 0 ? f.min : 0;
    case 'bool':
      return false;
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return [0, 0, 0];
    case 'enum':
      return optionValues(f)[0] ?? '';
    case 'string':
    case 'text':
    case 'code':
    case 'ref':
      return '';
    case 'color':
      return '#4fd1c5';
    case 'tags':
    case 'list':
      return [];
    case 'map':
      return {};
    case 'json':
      return null;
  }
}

function structuredCloneSafe(v: any) {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v;
}

/** Fill missing values with defaults (never removes unknown keys: user data is never dropped). */
export function withDefaults(fields: FieldDef[], values: Record<string, any> | undefined): Record<string, any> {
  const out: Record<string, any> = { ...(values ?? {}) };
  for (const f of fields) {
    if (out[f.key] === undefined) out[f.key] = defaultFor(f);
    else if (f.type === 'list' && f.itemFields && Array.isArray(out[f.key]))
      out[f.key] = out[f.key].map((it: any) => withDefaults(f.itemFields!, it));
  }
  return out;
}

export function coerce(f: FieldDef, v: any): any {
  switch (f.type) {
    case 'float': {
      let n = Number(v);
      if (!isFinite(n)) n = defaultFor(f);
      return n;
    }
    case 'int': {
      let n = Math.round(Number(v));
      if (!isFinite(n)) n = defaultFor(f);
      return n;
    }
    case 'bool':
      return !!v;
    default:
      return v;
  }
}

export function sampleRandomization(r: Randomization, rng: Rng): number {
  if (r.dist === 'normal') {
    const mid = (r.min + r.max) / 2;
    const sd = (r.max - r.min) / 4;
    return clamp(mid + rng.normal() * sd, r.min, r.max);
  }
  return rng.range(r.min, r.max);
}

export const fieldLabel = (f: FieldDef) =>
  f.label ?? f.key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
