// Panels and workspaces are data. Each workspace is a saved arrangement of the same panels;
// users can pull any panel into any workspace and save their own layouts as workspaces.
import React from 'react';
import { Registry } from '../core/registry';
import { Viewport } from './viewport/Viewport';
import { OutlinerPanel, AssetsPanel } from './panels/world';
import { PropertiesPanel } from './panels/properties';
import { ComponentStackPanel, EntityGraphPanel } from './panels/entity';
import { BrainGraphPanel, BrainStackPanel, LiveInputsPanel } from './panels/brain';
import { RewardTermsPanel, ScenariosPanel } from './panels/reward';
import { LiveAgentsPanel, RunDashboardPanel, RunsPanel, TrainConfigPanel, WorkersPanel } from './panels/train';
import { CheckpointsPanel, FailureGalleryPanel, ReplayPanel, TestSuitePanel } from './panels/evaluate';
import { IntegrationLogPanel, PackagePanel, TargetsPanel } from './panels/export';
import { ConsolePanel, ExtensionsPanel } from './panels/misc';
import { GraphPanel } from './graph/NodeGraph';
import { LiveBestPanel } from './panels/liveBest';

export interface PanelDef {
  id: string;
  title: string;
  icon: string;
  component: React.FC;
  source?: string;
}

export interface LayoutStep {
  panel: string;
  ref?: string;
  dir?: 'left' | 'right' | 'above' | 'below' | 'within';
  w?: number;
  h?: number;
  /** re-activate this (already added) panel once the layout is built */
  active?: boolean;
}

export interface WorkspaceDef {
  id: string;
  label: string;
  icon: string;
  question: string;
  layout: LayoutStep[];
  custom?: any; // serialized dock layout for user workspaces
  source?: string;
}

export const panels = new Registry<PanelDef>('panel');
export const workspaces = new Registry<WorkspaceDef>('workspace');

panels.registerAll([
  { id: 'viewport', title: 'Viewport', icon: 'cube', component: () => <Viewport mode="world" /> },
  { id: 'entityView', title: 'Entity view', icon: 'entity', component: () => <Viewport mode="entity" /> },
  { id: 'rewardView', title: 'Reward view', icon: 'trophy', component: () => <Viewport mode="reward" /> },
  { id: 'outliner', title: 'Outliner', icon: 'outliner', component: OutlinerPanel },
  { id: 'properties', title: 'Properties', icon: 'properties', component: PropertiesPanel },
  { id: 'assets', title: 'Assets', icon: 'assets', component: AssetsPanel },
  { id: 'worldGraph', title: 'Rules graph', icon: 'graph', component: () => <GraphPanel kind="rule" title="Rules" /> },
  { id: 'components', title: 'Components', icon: 'stack', component: ComponentStackPanel },
  { id: 'entityGraph', title: 'Entity graph', icon: 'graph', component: EntityGraphPanel },
  { id: 'brainGraph', title: 'Brain graph', icon: 'brain', component: BrainGraphPanel },
  { id: 'brainStack', title: 'Brain stack', icon: 'stack', component: BrainStackPanel },
  { id: 'liveInputs', title: 'Live inputs', icon: 'sliders', component: LiveInputsPanel },
  { id: 'rewardGraph', title: 'Reward graph', icon: 'trophy', component: () => <GraphPanel kind="reward" title="Reward graph" /> },
  { id: 'terms', title: 'Terms', icon: 'chart', component: RewardTermsPanel },
  { id: 'scenarios', title: 'Scenarios', icon: 'flag', component: ScenariosPanel },
  { id: 'runs', title: 'Runs', icon: 'list', component: RunsPanel },
  { id: 'runDashboard', title: 'Curves', icon: 'chart', component: RunDashboardPanel },
  { id: 'liveAgents', title: 'Live agents', icon: 'grid', component: LiveAgentsPanel },
  { id: 'liveBest', title: 'Live best', icon: 'trophy', component: LiveBestPanel },
  { id: 'workers', title: 'Workers', icon: 'cpu', component: WorkersPanel },
  { id: 'trainConfig', title: 'Config', icon: 'settings', component: TrainConfigPanel },
  { id: 'checkpoints', title: 'Checkpoints', icon: 'history', component: CheckpointsPanel },
  { id: 'replay', title: 'Replay', icon: 'replay', component: ReplayPanel },
  { id: 'testSuite', title: 'Test suite', icon: 'check', component: TestSuitePanel },
  { id: 'failures', title: 'Failure gallery', icon: 'warn', component: FailureGalleryPanel },
  { id: 'targets', title: 'Targets', icon: 'export', component: TargetsPanel },
  { id: 'package', title: 'Package', icon: 'box', component: PackagePanel },
  { id: 'integration', title: 'Integration log', icon: 'list', component: IntegrationLogPanel },
  { id: 'console', title: 'Console', icon: 'console', component: ConsolePanel },
  { id: 'extensions', title: 'Extensions', icon: 'plug', component: ExtensionsPanel },
]);

workspaces.registerAll([
  {
    id: 'world',
    label: 'World',
    icon: 'world',
    question: 'Where does the agent live?',
    layout: [
      { panel: 'viewport' },
      { panel: 'assets', ref: 'viewport', dir: 'left', w: 250 },
      { panel: 'outliner', ref: 'viewport', dir: 'right', w: 300 },
      { panel: 'properties', ref: 'outliner', dir: 'below', h: 420 },
      { panel: 'worldGraph', ref: 'viewport', dir: 'below', h: 240 },
      { panel: 'console', ref: 'worldGraph', dir: 'within' },
    ],
  },
  {
    id: 'entity',
    label: 'Entity',
    icon: 'entity',
    question: 'What is the agent made of?',
    layout: [
      { panel: 'entityView' },
      { panel: 'components', ref: 'entityView', dir: 'left', w: 290 },
      { panel: 'properties', ref: 'entityView', dir: 'right', w: 330 },
      { panel: 'entityGraph', ref: 'entityView', dir: 'below', h: 250 },
      { panel: 'worldGraph', ref: 'entityGraph', dir: 'within' },
    ],
  },
  {
    id: 'brain',
    label: 'Brain',
    icon: 'brain',
    question: 'How does it decide?',
    layout: [
      { panel: 'brainGraph' },
      { panel: 'brainStack', ref: 'brainGraph', dir: 'right', w: 330 },
      { panel: 'liveInputs', ref: 'brainStack', dir: 'below', h: 420 },
      { panel: 'properties', ref: 'liveInputs', dir: 'within' },
      { panel: 'entityView', ref: 'brainGraph', dir: 'below', h: 260 },
    ],
  },
  {
    id: 'reward',
    label: 'Reward',
    icon: 'reward',
    question: 'What counts as success?',
    layout: [
      { panel: 'rewardView' },
      { panel: 'rewardGraph', ref: 'rewardView', dir: 'below', h: 330 },
      { panel: 'terms', ref: 'rewardView', dir: 'right', w: 340 },
      { panel: 'scenarios', ref: 'terms', dir: 'below', h: 330 },
      { panel: 'properties', ref: 'scenarios', dir: 'within' },
    ],
  },
  {
    id: 'train',
    label: 'Train',
    icon: 'train',
    question: 'Is it learning?',
    layout: [
      { panel: 'runDashboard' },
      { panel: 'runs', ref: 'runDashboard', dir: 'left', w: 280 },
      { panel: 'workers', ref: 'runDashboard', dir: 'right', w: 320 },
      { panel: 'trainConfig', ref: 'workers', dir: 'below', h: 470 },
      { panel: 'liveBest', ref: 'runDashboard', dir: 'below', h: 400 },
      { panel: 'liveAgents', ref: 'liveBest', dir: 'within' },
      { panel: 'console', ref: 'liveBest', dir: 'within' },
      { panel: 'liveBest', active: true },
    ],
  },
  {
    id: 'evaluate',
    label: 'Evaluate',
    icon: 'evaluate',
    question: 'Is it good and safe to ship?',
    layout: [
      { panel: 'replay' },
      { panel: 'checkpoints', ref: 'replay', dir: 'left', w: 270 },
      { panel: 'testSuite', ref: 'replay', dir: 'right', w: 330 },
      { panel: 'failures', ref: 'testSuite', dir: 'below', h: 360 },
    ],
  },
  {
    id: 'export',
    label: 'Export',
    icon: 'export',
    question: 'Where does it go?',
    layout: [
      { panel: 'targets' },
      { panel: 'package', ref: 'targets', dir: 'right', w: 360 },
      { panel: 'integration', ref: 'package', dir: 'below', h: 300 },
      { panel: 'extensions', ref: 'targets', dir: 'below', h: 260 },
    ],
  },
]);

// user-saved workspaces persist in this browser
const KEY = 'cl.workspaces.custom';
try {
  for (const w of JSON.parse(localStorage.getItem(KEY) ?? '[]')) workspaces.register({ ...w, layout: [] }, 'user');
} catch {
  /* none */
}
export function saveCustomWorkspace(name: string, layoutJson: any, icon = 'layout') {
  const w: WorkspaceDef = { id: `user-${Date.now().toString(36)}`, label: name, icon, question: 'Your layout', layout: [], custom: layoutJson };
  workspaces.register(w, 'user');
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    list.push(w);
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage blocked */
  }
  return w.id;
}
