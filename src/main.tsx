// Studio entry: boot the engine (built-in plugin + physics), add browser importers,
// restore the last project from the cache or show the template gallery.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { boot } from './boot';
import { installPlugin, loadProjectExtensions } from './core/plugins';
import { browserImporters } from './ui/viewport/assets';
import { App } from './ui/App';
import { studio } from './ui/store';
import { loadCached } from './ui/persist';
import { sim } from './ui/sim/controller';
import { trainer } from './ui/train/manager';
import { newFromTemplate } from './ui/actions';
import './ui/llm';
import './ui/styles/theme.css';

const root = createRoot(document.getElementById('root')!);

async function start() {
  root.render(
    <div className="loading-screen">
      <svg className="pulse" width="56" height="56" viewBox="0 0 32 32" dangerouslySetInnerHTML={{ __html: document.getElementById('logo-src')!.innerHTML }} />
      <div>Starting the engine…</div>
    </div>,
  );
  await boot();
  installPlugin({ id: 'browser', name: 'Browser importers', version: '0.2.0', register: ({ registries }) => registries.importers.registerAll(browserImporters) });
  const params = new URLSearchParams(location.search);
  const cached = params.has('fresh') ? undefined : await loadCached();
  if (cached) {
    loadProjectExtensions(cached);
    studio().setProject(cached, { storage: { kind: 'browser' } });
    studio().log(`Restored ${cached.name} from the browser cache.`, 'info');
  } else studio().setWelcome(true);
  root.render(<App />);
  // automation hook (tests, scripting from devtools)
  (window as any).creatureLab = { studio, sim, trainer, newFromTemplate };
}
start().catch((e) => {
  root.render(<div className="loading-screen bad">Failed to start: {String(e?.message ?? e)}</div>);
  console.error(e);
});
