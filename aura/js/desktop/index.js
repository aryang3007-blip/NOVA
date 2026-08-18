/**
 * AURA :: Desktop Integration Framework
 * -------------------------------------
 * Single entry point that assembles the whole desktop stack:
 *
 *      PermissionManager ─┐
 *      AppDatabase ───────┼─▶ AppLauncher ─┐
 *      LocalActions ──────┘                ├─▶ ActionManager ◀── AI
 *                          DesktopPlugins ─┘
 *                          DesktopSetupFlow
 *
 * Nothing here is Windows-specific. The framework runs today in mock mode
 * and upgrades itself automatically the moment a host process appears.
 */

import { PermissionManager, PERMISSIONS, RISK } from './permissions.js';
import { AppDatabase, CATEGORIES } from './app-database.js';
import { AppLauncher, BACKEND } from './app-launcher.js';
import { ActionManager, DENY } from './action-manager.js';
import { registerDesktopPlugins } from './plugins/index.js';
import { DesktopSetupFlow, STEPS as SETUP_STEPS } from './setup-flow.js';

export class DesktopFramework {
  /**
   * @param {{bus?:object, bridge?:object, logger?:Function, storage?:Storage}} opts
   */
  constructor({ bus = null, bridge = null, logger = null, storage = null } = {}) {
    this.bus = bus;
    this.bridge = bridge;                 // LocalActions (serve.py) if present
    this.log = logger || (() => {});
    this.initialized = false;

    this.permissions = new PermissionManager({
      storage,
      onChange: (e) => this.bus?.emit('desktop:permission-changed', e),
    });
    this.database = new AppDatabase({ storage });
    this.launcher = new AppLauncher({ db: this.database, bridge, logger: this.log });
    this.actions = new ActionManager({ permissions: this.permissions, bus, logger: this.log });
    this.setup = new DesktopSetupFlow({
      permissions: this.permissions, launcher: this.launcher, storage, bus,
    });
  }

  /** Boot the framework. Safe to call once at app startup. */
  async initialize() {
    const init = await this.launcher.initialize();

    this.actions.setContext({
      launcher: this.launcher,
      database: this.database,
      permissions: this.permissions,
      bridge: this.bridge,
      bus: this.bus,
    });

    const ids = registerDesktopPlugins(this.actions, {
      launcher: this.launcher,
      bridge: this.bridge,
    });

    this.initialized = true;
    this.log(`Desktop framework: ${init.backend} backend, ${ids.length} plugins, ${this.actions.actions.size} actions`);
    this.bus?.emit('desktop:ready', this.status());
    return this.status();
  }

  /** Convenience passthrough used by the AI pipeline. */
  execute(request, meta) { return this.actions.execute(request, meta); }

  /** Everything the Settings panel needs, in one call. */
  status() {
    const l = this.launcher.status();
    return {
      initialized: this.initialized,
      backend: l.backend,
      platform: l.platform,
      capabilities: l.capabilities,
      simulated: l.capabilities.simulated,
      apps: this.database.stats(),
      permissions: this.permissions.summary(),
      plugins: this.actions.listPlugins(),
      actions: this.actions.listActions(),
      setupComplete: this.setup.isComplete,
      audit: this.actions.recentAudit(10),
    };
  }

  /** Injected into the AI system prompt so the model knows its real powers. */
  describeForAI() {
    if (!this.initialized) return 'Desktop integration is not initialised.';
    const st = this.launcher.status();
    const lines = [this.actions.describeForAI()];
    if (st.capabilities.simulated) {
      lines.push('NOTE: no desktop host process is running, so any desktop action will be SIMULATED. ' +
                 'Tell the user plainly if they ask you to do something real.');
    }
    return lines.join('\n');
  }
}

export {
  PermissionManager, PERMISSIONS, RISK,
  AppDatabase, CATEGORIES,
  AppLauncher, BACKEND,
  ActionManager, DENY,
  DesktopSetupFlow, SETUP_STEPS,
  registerDesktopPlugins,
};
export default DesktopFramework;
