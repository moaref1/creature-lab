// Picks the renderer for the world: flat Canvas2D for 2D worlds, three.js for 3D.
import { SceneRenderer, type PickResult } from './renderer';
import { Renderer2D } from './renderer2d';
import type { DebugShape, Drawable } from '../../core/sim/world';
import type { V3 } from '../../core/util';

export class ViewRenderer {
  private r: SceneRenderer | Renderer2D;
  private _follow: string | null = null;
  private _onFrame?: () => void;
  private _onGizmo?: (docId: string, obj: any, done: boolean) => void;
  private _visible = true;
  constructor(
    private host: HTMLElement,
    initial: 2 | 3 = 3,
  ) {
    this.r = initial === 2 ? new Renderer2D(host) : new SceneRenderer(host);
  }
  get dim() {
    return this.r.dim;
  }
  get view() {
    return this.r instanceof Renderer2D ? this.r.view : undefined;
  }
  setDim(dim: 2 | 3, view: 'side' | 'top' = 'side') {
    const want2d = dim === 2;
    if (want2d !== this.r instanceof Renderer2D) {
      this.r.dispose();
      this.r = want2d ? new Renderer2D(this.host) : new SceneRenderer(this.host);
      this.r.follow = this._follow;
      this.r.onFrame = this._onFrame;
      this.r.onGizmo = this._onGizmo;
      this.r.visible = this._visible;
    }
    if (this.r instanceof Renderer2D) this.r.leftLock = this._leftLock;
    if (this.r instanceof Renderer2D) this.r.view = view;
    else this.r.setDim(dim);
    this.r.needsFrame = true;
  }
  set follow(v: string | null) {
    this._follow = v;
    this.r.follow = v;
  }
  set onFrame(f: (() => void) | undefined) {
    this._onFrame = f;
    this.r.onFrame = f;
  }
  set onGizmo(f: ((docId: string, obj: any, done: boolean) => void) | undefined) {
    this._onGizmo = f;
    this.r.onGizmo = f;
  }
  private _leftLock = false;
  set leftLock(v: boolean) {
    this._leftLock = v;
    if (this.r instanceof Renderer2D) this.r.leftLock = v;
  }
  get pxPerMetre() {
    return this.r instanceof Renderer2D ? this.r.pxPerMetre : 40;
  }
  setAmbience(a: { kind: string; background?: string }) {
    if (this.r instanceof Renderer2D) this.r.ambience = a;
  }
  addPopup(pos: V3, text: string, color: string) {
    if (this.r instanceof Renderer2D) this.r.addPopup(pos, text, color);
  }
  set visible(v: boolean) {
    this._visible = v;
    this.r.visible = v;
  }
  set needsFrame(v: boolean) {
    this.r.needsFrame = v;
  }
  get gizmo() {
    return this.r.gizmo as { dragging: boolean };
  }
  sync(ds: Drawable[], sel?: string | null) {
    this.r.sync(ds, sel);
  }
  setDebug(d: DebugShape[]) {
    this.r.setDebug(d);
  }
  project(p: V3) {
    return this.r.project(p);
  }
  pick(x: number, y: number): PickResult | null {
    return this.r.pick(x, y);
  }
  groundPoint(x: number, y: number): V3 {
    return this.r.groundPoint(x, y);
  }
  attachGizmo(docId: string | null, mode: 'translate' | 'rotate' | 'scale') {
    this.r.attachGizmo(docId, mode);
  }
  frameAll() {
    this.r.frameAll();
  }
  dispose() {
    this.r.dispose();
  }
}
