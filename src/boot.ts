// One boot path for the editor, workers and the CLI.
import { installPlugin, initPhysics } from './core/plugins';
import { builtinPlugin } from './plugins/builtin';

let booted: Promise<void> | null = null;
export function boot(): Promise<void> {
  if (!booted) {
    installPlugin(builtinPlugin);
    booted = initPhysics();
  }
  return booted;
}
