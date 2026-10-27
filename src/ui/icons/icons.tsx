// Built-in icon set: 24px grid, 1.75 stroke, currentColor. Each icon is data (SVG
// children as a string), so plugins can register more with registerIcon().
import React from 'react';

const P = (d: string) => `<path d="${d}"/>`;
const C = (cx: number, cy: number, r: number, fill = false) => `<circle cx="${cx}" cy="${cy}" r="${r}"${fill ? ' fill="currentColor" stroke="none"' : ''}/>`;
const R = (x: number, y: number, w: number, h: number, rx = 2) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}"/>`;
const L = (x1: number, y1: number, x2: number, y2: number) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"/>`;

const icons: Record<string, string> = {
  // workspaces
  world: C(12, 12, 9) + P('M3 12h18M12 3c2.8 3 2.8 15 0 18M12 3c-2.8 3-2.8 15 0 18'),
  entity: C(12, 6, 3) + P('M12 9v6M7 21l5-6 5 6M6 12h12'),
  brain: P('M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 3 3h1V4H9zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-3 3h-1V4h1z') + P('M10 9H8M14 9h2M10 14H7M14 14h3'),
  reward: P('M8 4h8v5a4 4 0 0 1-8 0V4zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 20h8M10 17h4'),
  train: P('M3 20h18') + P('M5 16l4-5 3 3 6-8') + C(18, 6, 1.5, true),
  evaluate: C(11, 11, 6) + P('M20 20l-4.5-4.5M8.5 11l2 2 3.5-4'),
  export: P('M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5'),
  // shell
  search: C(11, 11, 6) + P('M20 20l-4.3-4.3'),
  command: P('M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6z'),
  undo: P('M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2'),
  redo: P('M15 7l5 5-5 5M20 12H9a5 5 0 0 0 0 10h2'),
  save: P('M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z') + P('M7 3v6h8V3M7 21v-7h10v7'),
  folder: P('M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z'),
  'folder-open': P('M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7l-3 9H3V7z') + P('M7 10h15l-3 9H4z'),
  file: P('M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5z') + P('M14 3v5h5'),
  plus: P('M12 5v14M5 12h14'),
  minus: P('M5 12h14'),
  x: P('M6 6l12 12M18 6L6 18'),
  check: P('M5 12l5 5 9-10'),
  'chevron-right': P('M9 6l6 6-6 6'),
  'chevron-down': P('M6 9l6 6 6-6'),
  'chevron-left': P('M15 6l-6 6 6 6'),
  more: C(5, 12, 1.2, true) + C(12, 12, 1.2, true) + C(19, 12, 1.2, true),
  grip: C(9, 6, 1.1, true) + C(15, 6, 1.1, true) + C(9, 12, 1.1, true) + C(15, 12, 1.1, true) + C(9, 18, 1.1, true) + C(15, 18, 1.1, true),
  eye: P('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z') + C(12, 12, 3),
  'eye-off': P('M3 3l18 18M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6'),
  lock: R(5, 11, 14, 10) + P('M8 11V7a4 4 0 0 1 8 0v4'),
  unlock: R(5, 11, 14, 10) + P('M8 11V7a4 4 0 0 1 7.5-2'),
  trash: P('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'),
  copy: R(8, 8, 12, 12) + P('M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'),
  settings: C(12, 12, 3) + P('M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'),
  info: C(12, 12, 9) + P('M12 11v6M12 7.5v.5'),
  warn: P('M12 3l10 18H2L12 3zM12 10v5M12 18v.5'),
  error: C(12, 12, 9) + P('M9 9l6 6M15 9l-6 6'),
  bell: P('M6 16V11a6 6 0 0 1 12 0v5l2 2H4l2-2zM10 21h4'),
  layout: R(3, 4, 18, 16) + P('M3 9h18M9 9v11'),
  maximize: P('M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5'),
  popout: P('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
  console: R(3, 4, 18, 16) + P('M7 9l3 3-3 3M12 15h5'),
  // timeline
  play: P('M7 4l13 8-13 8V4z'),
  pause: R(6, 4, 4, 16, 1) + R(14, 4, 4, 16, 1),
  stop: R(6, 6, 12, 12, 1),
  step: P('M6 5l9 7-9 7V5zM18 5v14'),
  'step-back': P('M18 5l-9 7 9 7V5zM6 5v14'),
  restart: P('M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5'),
  record: C(12, 12, 6, true),
  gauge: P('M4 18a8 8 0 1 1 16 0M12 18l4-6'),
  clock: C(12, 12, 9) + P('M12 7v5l3 2'),
  keyboard: R(2, 6, 20, 12) + P('M6 10h1M10 10h1M14 10h1M18 10h1M7 14h10'),
  // viewport tools
  move: P('M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3'),
  rotate: P('M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5'),
  scale: R(4, 10, 10, 10, 1) + P('M10 4h10v10M14 10l6-6'),
  cursor: P('M5 3l14 7-6 2-2 6L5 3z'),
  brush: P('M18 3l3 3-9 9-3-3 9-9zM9 12c-3 0-5 2-5 5 0 1.5-1 2-2 2 2 2 7 2 9-1 1-1 1-3 1-3'),
  spline: P('M4 19c4 0 3-14 8-14s4 14 8 14') + C(4, 19, 1.5, true) + C(20, 19, 1.5, true) + C(12, 5, 1.5, true),
  tag: P('M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9-9-9z') + C(8, 8, 1.5, true),
  dice: R(4, 4, 16, 16, 3) + C(9, 9, 1.2, true) + C(15, 15, 1.2, true) + C(15, 9, 1.2, true) + C(9, 15, 1.2, true),
  camera: P('M4 8h3l2-3h6l2 3h3v11H4V8z') + C(12, 13, 3.5),
  grid: R(3, 3, 7, 7, 1) + R(14, 3, 7, 7, 1) + R(3, 14, 7, 7, 1) + R(14, 14, 7, 7, 1),
  frame: P('M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4') + R(8, 8, 8, 8, 1),
  import: P('M12 15V3M7 10l5 5 5-5M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4'),
  link: P('M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'),
  // world objects
  cube: P('M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9'),
  sphere: C(12, 12, 8.5) + P('M3.5 12c0 2.5 3.8 4.5 8.5 4.5s8.5-2 8.5-4.5'),
  cylinder: P('M5 6c0-1.7 3.1-3 7-3s7 1.3 7 3v12c0 1.7-3.1 3-7 3s-7-1.3-7-3V6z') + P('M5 6c0 1.7 3.1 3 7 3s7-1.3 7-3'),
  capsule: R(7, 2.5, 10, 19, 5),
  ground: P('M2 17h20M5 21l3-4M10 21l3-4M15 21l3-4M8 13l4-6 4 6'),
  mountain: P('M2 20l7-11 4 6 3-4 6 9H2z'),
  zone: R(4, 4, 16, 16, 2) + P('M4 9h3M17 9h3M4 15h3M17 15h3'),
  spawn: C(12, 10, 3) + P('M12 21s-7-5.5-7-11a7 7 0 0 1 14 0c0 5.5-7 11-7 11z'),
  model: P('M12 2l9 5v10l-9 5-9-5V7l9-5z') + P('M12 12l9-5M12 12v10M12 12L3 7'),
  image: R(3, 4, 18, 16) + C(8.5, 9.5, 1.8) + P('M21 16l-5-5-9 9'),
  vector: P('M5 19L19 5') + R(2, 16, 5, 5, 1) + R(17, 3, 5, 5, 1) + P('M7 5h7M19 10v7'),
  // entity parts
  skeleton: C(12, 4.5, 2.5) + P('M12 7v8M8 10h8M12 15l-4 6M12 15l4 6'),
  car: P('M3 15l2-6a2 2 0 0 1 2-1.4h10A2 2 0 0 1 19 9l2 6v3H3v-3zM3 15h18') + C(7, 18, 2) + C(17, 18, 2),
  'circle-dashed': P('M10.1 3.2a9 9 0 0 1 3.8 0M17 5a9 9 0 0 1 2.7 2.7M20.8 10.1a9 9 0 0 1 0 3.8M19 17a9 9 0 0 1-2.7 2.7M13.9 20.8a9 9 0 0 1-3.8 0M7 19a9 9 0 0 1-2.7-2.7M3.2 13.9a9 9 0 0 1 0-3.8M5 7a9 9 0 0 1 2.7-2.7'),
  rays: C(5, 12, 2) + P('M7 12h14M7 11l12-6M7 13l12 6'),
  joint: C(12, 12, 3) + P('M4 4l6 6M14 14l6 6'),
  touch: P('M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V4a1.5 1.5 0 0 1 3 0v6M15 9a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-2.5-4a1.5 1.5 0 0 1 2.5-1.7L9 15V8'),
  target: C(12, 12, 9) + C(12, 12, 5) + C(12, 12, 1.5, true),
  people: C(9, 8, 3) + P('M3 20a6 6 0 0 1 12 0') + C(17, 9, 2.5) + P('M15.5 14a5 5 0 0 1 6 5'),
  sliders: P('M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0') + C(16, 6, 2) + C(10, 12, 2) + C(18, 18, 2),
  message: P('M4 5h16v11H9l-5 4V5z'),
  motor: C(12, 12, 4) + P('M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1'),
  steering: C(12, 12, 9) + C(12, 12, 2) + P('M12 14v7M10 12.5L4 15M14 12.5l6 2.5'),
  fist: P('M7 9V7a1.5 1.5 0 0 1 3 0v2M10 9V6a1.5 1.5 0 0 1 3 0v3M13 9V7a1.5 1.5 0 0 1 3 0v3M16 10a1.5 1.5 0 0 1 3 0v3a7 7 0 0 1-7 7h-1a6 6 0 0 1-6-6v-3a2 2 0 0 1 2-2h3'),
  choice: P('M12 21V12M12 12L5 4M12 12l7-8M5 4v4M5 4h4M19 4v4M19 4h-4'),
  heart: P('M12 20s-8-4.7-8-10.5A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 8 2.5C20 15.3 12 20 12 20z'),
  drop: P('M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z'),
  mask: P('M4 6c5-2 11-2 16 0 0 7-3 13-8 13S4 13 4 6z') + P('M8 10.5h2M14 10.5h2M9 15c2 1.3 4 1.3 6 0'),
  memory: R(5, 5, 14, 14, 2) + R(9, 9, 6, 6, 1) + P('M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3'),
  pulse: P('M3 12h4l3-7 4 14 3-7h4'),
  box: P('M3 7l9-4 9 4v10l-9 4-9-4V7zM3 7l9 4 9-4M12 11v10'),
  apple: P('M12 7c-2-2-7-2-7 4s3 9 5 9c1 0 1.5-.5 2-.5s1 .5 2 .5c2 0 5-3 5-9s-5-6-7-4zM12 7c0-2 1-4 3-4'),
  // brains
  network: C(5, 6, 2) + C(5, 18, 2) + C(12, 12, 2) + C(19, 6, 2) + C(19, 18, 2) + P('M7 6.5l3 4.5M7 17.5l3-4.5M14 11l3-4M14 13l3 4'),
  tree: R(9, 3, 6, 4, 1) + R(3, 17, 6, 4, 1) + R(15, 17, 6, 4, 1) + P('M12 7v5M6 17v-5h12v5'),
  balance: P('M12 4v16M6 20h12M4 8h16M7 8l-3 7h6l-3-7zM17 8l-3 7h6l-3-7z'),
  states: C(6, 6, 3) + C(18, 18, 3) + C(18, 6, 3) + P('M9 6h6M18 9v6M8.2 8.2l7.6 7.6'),
  code: P('M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16'),
  chat: P('M4 5h16v11h-7l-5 4v-4H4V5z') + P('M8 10h8M8 13h5'),
  // nodes / categories
  hand: P('M8 13V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7 6 6 0 0 1-5-3l-2-3.5a1.5 1.5 0 0 1 2.5-1.6L8 15'),
  function: P('M15 4h-2a3 3 0 0 0-3 3v10a3 3 0 0 1-3 3H5M7 11h7M15 14l5 5M20 14l-5 5'),
  globe: C(12, 12, 9) + P('M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18'),
  trophy: P('M8 4h8v5a4 4 0 0 1-8 0V4zM12 13v4M8 20h8'),
  // targets
  unity: P('M12 2l8.5 5v10L12 22l-8.5-5V7L12 2z') + P('M12 12l8.5-5M12 12v10M12 12L3.5 7'),
  unreal: C(12, 12, 9) + P('M9 7v7c0 2 1 3 3 3s3-1 3-3V7'),
  godot: P('M5 9l2-5 3 2h4l3-2 2 5v6a5 5 0 0 1-5 5H10a5 5 0 0 1-5-5V9z') + C(9.5, 12, 1.5, true) + C(14.5, 12, 1.5, true),
  robot: R(5, 8, 14, 11, 2) + P('M12 4v4M9 13h0M15 13h0M9 16h6') + C(12, 3.5, 1.2, true) + C(9, 12.5, 1.2, true) + C(15, 12.5, 1.2, true),
  python: P('M12 3c-4 0-4 2-4 3v2h4v1H6c-2 0-3 1.5-3 4s1 4 3 4h2v-3c0-1.5 1-2.5 2.5-2.5h4c1.5 0 2.5-1 2.5-2.5V6c0-1.5-1.5-3-6-3zM12 21c4 0 4-2 4-3v-2h-4v-1h6c2 0 3-1.5 3-4s-1-4-3-4h-2v3c0 1.5-1 2.5-2.5 2.5h-4C8 12.5 7 13.5 7 15v3c0 1.5 1.5 3 5 3z'),
  chip: R(6, 6, 12, 12, 2) + R(9.5, 9.5, 5, 5, 1) + P('M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3'),
  // misc
  square: R(4, 4, 16, 16, 2),
  truck: P('M2 6h12v10H2zM14 10h4l3 3v3h-7') + C(6, 18, 2) + C(17, 18, 2),
  sparkles: P('M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z'),
  fork: C(6, 5, 2) + C(18, 5, 2) + C(12, 19, 2) + P('M6 7v2a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4V7M12 13v4'),
  sweep: P('M4 20V10M9 20V4M14 20v-7M19 20V8'),
  flag: P('M5 21V4M5 4h12l-2 4 2 4H5'),
  cpu: R(5, 5, 14, 14, 2) + P('M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3') + R(9, 9, 6, 6, 1),
  zap: P('M13 2L4 14h7l-1 8 9-12h-7l1-8z'),
  history: P('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 3'),
  plug: P('M9 2v6M15 2v6M6 8h12v3a6 6 0 0 1-12 0V8zM12 17v5'),
  book: P('M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4V4zM20 4h-5a3 3 0 0 0-3 3'),
  wand: P('M4 20L16 8M14 6l4 4M18 2v3M21 5h-3M20 9v2M10 3H8'),
  graph: C(5, 7, 2.5) + C(19, 7, 2.5) + C(12, 17, 2.5) + P('M7.5 7h9M6.5 9.2l4 5.6M17.5 9.2l-4 5.6'),
  outliner: P('M4 5h4M10 5h10M6 10h4M12 10h8M6 15h4M12 15h8M4 20h4M10 20h10'),
  properties: P('M4 6h16M4 12h16M4 18h10') + C(17, 18, 2),
  assets: R(3, 3, 8, 8, 2) + R(13, 3, 8, 8, 2) + R(3, 13, 8, 8, 2) + C(17, 17, 4),
  stack: P('M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17l9 5 9-5'),
  chart: P('M4 20V4M4 20h16M8 16l4-5 3 3 5-6'),
  replay: P('M4 12a8 8 0 1 1 3 6.3M4 20v-5h5') + P('M10 9l5 3-5 3V9z'),
  list: P('M8 6h12M8 12h12M8 18h12') + C(4, 6, 1, true) + C(4, 12, 1, true) + C(4, 18, 1, true),
  palette: C(12, 12, 9) + C(8, 10, 1.3, true) + C(12, 7.5, 1.3, true) + C(16, 10, 1.3, true) + P('M12 21a2 2 0 0 1 0-4h2a3 3 0 0 0 3-3'),
};

export function registerIcon(name: string, svgInner: string) {
  icons[name] = svgInner;
}
export const iconNames = () => Object.keys(icons);

export function Icon({ name, size = 16, className, style, title }: { name: string; size?: number; className?: string; style?: React.CSSProperties; title?: string }) {
  const inner = icons[name] ?? icons.square;
  return (
    <svg
      className={`icon ${className ?? ''}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      dangerouslySetInnerHTML={{ __html: (title ? `<title>${title}</title>` : '') + inner }}
    />
  );
}

/** Creature Lab mark: a hexagonal cell holding a three-node neural creature. */
export function LogoMark({ size = 22, accent = 'var(--accent)' }: { size?: number; accent?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-label="Creature Lab" role="img">
      <path d="M16 2.6 27.6 9.3v13.4L16 29.4 4.4 22.7V9.3Z" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <g stroke={accent} strokeWidth="1.8" strokeLinecap="round">
        <line x1="16" y1="16" x2="16" y2="8.8" />
        <line x1="16" y1="16" x2="22.2" y2="19.6" />
        <line x1="16" y1="16" x2="9.8" y2="19.6" />
      </g>
      <circle cx="16" cy="8.4" r="2.1" fill="currentColor" />
      <circle cx="22.6" cy="19.8" r="2.1" fill="currentColor" />
      <circle cx="9.4" cy="19.8" r="2.1" fill="currentColor" />
      <circle cx="16" cy="16" r="3.6" fill={accent} />
    </svg>
  );
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word">
        Creature<b>Lab</b>
      </span>
    </span>
  );
}

/** The same mark as a standalone SVG string (favicon, app icon, exports). */
export const logoSvg = (accent = '#2dd4bf', fg = '#e6e9ee', bg = '#0f1115') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/><g transform="translate(3.2 3.2) scale(.8)"><path d="M16 2.6 27.6 9.3v13.4L16 29.4 4.4 22.7V9.3Z" fill="none" stroke="${fg}" stroke-width="2.2" stroke-linejoin="round"/><g stroke="${accent}" stroke-width="1.8" stroke-linecap="round"><line x1="16" y1="16" x2="16" y2="8.8"/><line x1="16" y1="16" x2="22.2" y2="19.6"/><line x1="16" y1="16" x2="9.8" y2="19.6"/></g><circle cx="16" cy="8.4" r="2.1" fill="${fg}"/><circle cx="22.6" cy="19.8" r="2.1" fill="${fg}"/><circle cx="9.4" cy="19.8" r="2.1" fill="${fg}"/><circle cx="16" cy="16" r="3.6" fill="${accent}"/></g></svg>`;
