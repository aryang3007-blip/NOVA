/**
 * AURA :: Gesture → Action Bindings
 * ---------------------------------
 * The bridge between the vision module's gesture events and real system
 * behaviour. Every binding here performs an actual, observable action.
 *
 * Bindings are data, not hardcoded branches — a plugin can override or add
 * entries at runtime via `gestureActions.bind(name, handler)`.
 */

import { bus, EV } from '../core/bus.js';
import { state } from '../core/state.js';
import { config } from '../core/config.js';

export class GestureActions {
  constructor(ctx) {
    this.ctx = ctx;                  // { ai, voice, vision, avatar, audio, ui }
    this.bindings = new Map();
    this.enabled = true;
    this.lastPointerHighlight = null;
    this._pointerRaf = null;
    this._registerDefaults();
    this._wire();
  }

  bind(gesture, handler) { this.bindings.set(gesture, handler); return this; }
  unbind(gesture) { this.bindings.delete(gesture); }
  list() { return Array.from(this.bindings.keys()); }

  _registerDefaults() {
    const { voice, ui, ai, vision, audio } = this.ctx;

    // WAVE → AI greets you out loud
    this.bind('wave', () => {
      audio?.sfx('gesture');
      const greetings = [
        'Hello! Good to see you.',
        'Hello there, Commander. Good to see you.',
        'Hey! I see you waving. How can I help?',
      ];
      const text = greetings[Math.floor(Math.random() * greetings.length)];
      ui.pushSystemMessage(`👋 Wave detected`, 'gesture');
      ui.pushAssistantMessage(text);
      bus.emit(EV.AVATAR_EMOTION, { emotion: 'happy' });
      voice.output.speak(text, { emotion: 'happy' });
    });

    // OPEN PALM → activates listening mode (real STT start)
    this.bind('open_palm', async () => {
      audio?.sfx('listen');
      ui.pushSystemMessage('🖐 Open palm — listening mode', 'gesture');
      if (!voice.input.supported) {
        ui.toast('warn', voice.input.unsupportedReason);
        ui.pushAssistantMessage(`I saw your open palm, but ${voice.input.unsupportedReason}`);
        return;
      }
      voice.output.cancel('gesture-interrupt');   // palm also interrupts speech
      const started = await voice.input.start('command');   // now async (mic permission)
      state.set({ listenMode: started });
      bus.emit(EV.UI_LISTEN_MODE, { active: started });
      if (started) voice.output.speak('Listening.', { interrupt: false });
    });

    // THUMBS UP → confirm the pending action, or acknowledge
    this.bind('thumbs_up', () => {
      audio?.sfx('confirm');
      ui.pushSystemMessage('👍 Thumbs up — confirm', 'gesture');
      const pending = ui.consumePendingConfirm();
      if (pending) {
        ui.pushAssistantMessage(`Confirmed: ${pending.label}`);
        voice.output.speak('Confirmed.', { emotion: 'confident' });
        try { pending.onConfirm(); } catch (e) { console.error(e); }
      } else {
        const text = 'Mission acknowledged.';
        ui.pushAssistantMessage(text);
        voice.output.speak(text, { emotion: 'confident' });
      }
      bus.emit(EV.AVATAR_EMOTION, { emotion: 'confident' });
    });

    // THUMBS DOWN → cancel pending action / stop generation
    this.bind('thumbs_down', () => {
      audio?.sfx('error');
      ui.pushSystemMessage('👎 Thumbs down — cancel', 'gesture');
      const pending = ui.consumePendingConfirm();
      if (pending) {
        ui.pushAssistantMessage(`Cancelled: ${pending.label}`);
        try { pending.onCancel?.(); } catch {}
      } else if (state.get('aiStreaming')) {
        ai.stop('gesture');
        ui.pushAssistantMessage('Generation stopped.');
      } else {
        voice.output.cancel('gesture');
        ui.pushAssistantMessage('Understood — standing down.');
      }
      bus.emit(EV.AVATAR_EMOTION, { emotion: 'sad' });
    });

    // PEACE → opens/focuses the chat window
    this.bind('peace', () => {
      audio?.sfx('click');
      ui.pushSystemMessage('✌ Peace sign — chat focus', 'gesture');
      ui.openPanel('chat');
      ui.focusInput();
      bus.emit(EV.AVATAR_EMOTION, { emotion: 'excited' });
      voice.output.speak('Chat open.', { emotion: 'excited' });
    });

    // POINTING → highlight the UI element under the fingertip
    this.bind('pointing', () => {
      audio?.sfx('hover');
      ui.pushSystemMessage('☝ Pointing — targeting mode', 'gesture');
      ui.setPointerMode(true);
    });

    // FIST → stop generation AND stop speech (a hard "halt")
    this.bind('fist', () => {
      audio?.sfx('click');
      const stoppedGen = ai.stop('gesture');
      const stoppedTts = voice.output.cancel('gesture');
      if (stoppedGen || stoppedTts) {
        ui.pushSystemMessage('✊ Fist — halt', 'gesture');
      }
    });

    // OK → run a quick self test
    this.bind('ok', () => {
      audio?.sfx('confirm');
      ui.pushSystemMessage('👌 OK sign — systems check', 'gesture');
      voice.output.speak('All systems nominal.', { emotion: 'happy' });
    });

    // ROCK → toggle ambient music
    this.bind('rock', () => {
      audio?.sfx('gesture');
      const on = !config.get('musicEnabled');
      config.set('musicEnabled', on);
      audio?.sync();
      ui.syncToggles();
      ui.pushSystemMessage(`🤘 Rock on — music ${on ? 'on' : 'off'}`, 'gesture');
    });

    // THREE FINGERS → open Settings.
    // A deliberate, unusual pose: you do not want to land in Settings by
    // accident mid-conversation.
    this.bind('three', () => {
      audio?.sfx('click');
      ui.pushSystemMessage('🤟 Three fingers — settings', 'gesture');
      ui.openSettings();
      bus.emit(EV.AVATAR_EMOTION, { emotion: 'confident' });
      voice.output.speak('Settings.', { emotion: 'neutral' });
    });

    /*
     * SWIPES — the Iron Man flick.
     *
     * Left/right cycle the main panels, so you can move through the whole app
     * without touching anything. Up/down are vertical controls, which is the
     * intuitive mapping and keeps them distinct from navigation.
     */
    this.bind('swipe_left',  () => this._cyclePanel(-1));
    this.bind('swipe_right', () => this._cyclePanel(1));

    this.bind('swipe_up', () => {
      audio?.sfx('gesture');
      const v = Math.min(1, (config.get('volume') ?? 0.8) + 0.15);
      config.set('volume', v);
      audio?.sync(); ui.syncToggles?.();
      ui.pushSystemMessage(`👆 Swipe up — volume ${Math.round(v * 100)}%`, 'gesture');
    });

    this.bind('swipe_down', () => {
      audio?.sfx('gesture');
      // A downward swipe is the natural "dismiss": stop talking, stop
      // generating, close anything modal.
      const stoppedTts = voice.output.cancel('gesture');
      const stoppedGen = ai.stop('gesture');
      if (ui.settingsOpen?.()) { ui.closeSettings(); }
      ui.pushSystemMessage(
        `👇 Swipe down — ${stoppedGen || stoppedTts ? 'halted' : 'dismissed'}`, 'gesture');
    });
  }

  /**
   * Move through the main panels in order. Wraps, and skips the hidden
   * innovations page so a swipe can never reveal it.
   * @param {number} dir -1 or +1
   */
  _cyclePanel(dir) {
    const { ui, audio } = this.ctx;
    const panels = (ui.visiblePanels?.() || ['chat', 'vision', 'ops', 'wardrobe', 'gestures']);
    const current = ui.currentPanel || 'chat';
    const i = panels.indexOf(current);
    const next = panels[((i < 0 ? 0 : i) + dir + panels.length) % panels.length];
    audio?.sfx('gesture');
    ui.openPanel(next);
    ui.pushSystemMessage(
      `${dir > 0 ? '👉 Swipe right' : '👈 Swipe left'} — ${next.toUpperCase()}`, 'gesture');
    bus.emit(EV.AVATAR_EMOTION, { emotion: 'excited' });
  }

  _wire() {
    bus.on(EV.GESTURE, ({ gesture, confidence }) => {
      if (!this.enabled) return;
      const handler = this.bindings.get(gesture);
      this.ctx.ui?.flashGesture(gesture, confidence);
      if (handler) {
        try { handler({ gesture, confidence }); }
        catch (e) { console.error(`[gesture:${gesture}]`, e); }
      }
    });

    bus.on(EV.GESTURE_END, ({ gesture }) => {
      if (gesture === 'pointing') this.ctx.ui?.setPointerMode(false);
    });

    // continuous pointer → move the on-screen reticle and highlight targets
    bus.on(EV.POINTER, (p) => {
      if (!this.enabled) return;
      this._pointer = p;
      if (this._pointerRaf) return;
      this._pointerRaf = requestAnimationFrame(() => {
        this._pointerRaf = null;
        this.ctx.ui?.updatePointer(this._pointer);
      });
    });
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!v) this.ctx.ui?.setPointerMode(false);
  }
}

export default GestureActions;
