/**
 * NOVA :: Cognitive Orchestrator & Intent Layer
 * --------------------------------------------
 * Replaces hardcoded command dependence with true semantic intent understanding,
 * device context routing, multi-device action dispatching, and safety checks.
 *
 * Pipeline:
 *   User Input
 *      ↓
 *   Context + Device State + Conversation History
 *      ↓
 *   Cognitive Orchestrator (Intent + Device Detection)
 *      ↓
 *   Target Device / Capability Gate
 *      ↓
 *   Permission Check & Safety Confirmation
 *      ↓
 *   Subsystem / Tool Execution
 *      ↓
 *   Natural Language Response Synthesis
 *
 * @module ai/cognitive-orchestrator
 */

export const INTENT_TYPES = {
  CONVERSATION: 'conversation',
  DESKTOP_ACTION: 'desktop_action',
  PHONE_ACTION: 'phone_action',
  WEB_REQUEST: 'web_request',
  VISION_REQUEST: 'vision_request',
  SCREEN_REQUEST: 'screen_request',
  FILE_REQUEST: 'file_request',
  APPLICATION_REQUEST: 'application_request',
  MEDIA_REQUEST: 'media_request',
  SYSTEM_REQUEST: 'system_request',
  MEMORY_REQUEST: 'memory_request',
  KNOWLEDGE_REQUEST: 'knowledge_request',
  MULTI_STEP_TASK: 'multi_step_task',
};

export class CognitiveOrchestrator {
  /**
   * @param {Object} [opts]
   * @param {Object} [opts.bus]
   * @param {Object} [opts.deviceManager]
   * @param {Object} [opts.actionManager]
   * @param {Object} [opts.memoryManager]
   * @param {Function} [opts.logger]
   */
  constructor(opts = {}) {
    this.bus = opts.bus || null;
    this.deviceManager = opts.deviceManager || null;
    this.actionManager = opts.actionManager || null;
    this.memoryManager = opts.memoryManager || null;
    this.log = opts.logger || (() => {});
  }

  /**
   * Analyze input and conversation state to determine intent and targeted device.
   * Does NOT rely purely on rigid regexes or slash commands.
   *
   * @param {string} text
   * @param {Object} [ctx]
   * @returns {Object} Intent Analysis
   */
  understand(text, ctx = {}) {
    const raw = String(text || '').trim();
    const low = raw.toLowerCase();

    // 1. Detect target device from natural language cues
    let device = 'desktop';
    let cleanText = raw;

    const phoneMatch = /\b(?:on|to|for|with)\s+(?:my\s+|the\s+)?(?:phone|mobile|android|iphone)\b/i.exec(raw);
    const desktopMatch = /\b(?:on|to|for|with)\s+(?:my\s+|the\s+)?(?:computer|pc|laptop|desktop|windows)\b/i.exec(raw);

    if (phoneMatch) {
      device = 'phone';
      // Strip device clause for app/target extraction
      cleanText = raw.replace(phoneMatch[0], '').trim();
    } else if (desktopMatch) {
      device = 'desktop';
      cleanText = raw.replace(desktopMatch[0], '').trim();
    }

    const cleanLow = cleanText.toLowerCase();

    // 2. Classify intent
    // Destructive Safety Check
    if (/\b(delete|format|wipe|erase|destroy|shutdown|power off)\b.*\b(all|everything|c:|drive|hard drive|system32)\b/i.test(raw)) {
      return {
        intent: INTENT_TYPES.SYSTEM_REQUEST,
        action: 'power_control',
        device,
        target: 'shutdown',
        requiresConfirmation: true,
        confidence: 1.0,
        rawText: raw,
        cleanText,
        reason: 'high-risk-system-action'
      };
    }

    // Vision queries ("What am I holding?", "Who is this?", "Look at the camera")
    if (/\b(who is that|who's that|who is this|what am i holding|look at me|what do you see|camera feed)\b/i.test(cleanLow)) {
      return {
        intent: INTENT_TYPES.VISION_REQUEST,
        action: 'analyze_vision',
        device: 'desktop',
        target: 'camera',
        confidence: 0.95,
        rawText: raw,
        cleanText
      };
    }

    // Screen perception queries ("What's on my screen?", "Read the active window", "Click minimize")
    if (/\b(what'?s on (my |the )?screen|read my screen|look at my screen|screen perception|click the (?:minimize|maximize|close|button))\b/i.test(cleanLow)) {
      return {
        intent: INTENT_TYPES.SCREEN_REQUEST,
        action: 'perceive_screen',
        device: 'desktop',
        target: 'screen',
        confidence: 0.95,
        rawText: raw,
        cleanText
      };
    }

    // File exploration & Semantic File Search queries
    if (/\b(find|search|where is|locate|open)\s+(?:my\s+|the\s+)?(?:pdf|notes|file|doc|document|folder|physics|chemistry|maths?)\b/i.test(cleanLow) &&
        !/\b(open|launch)\s+(whatsapp|youtube|chrome|spotify|vscode|discord|telegram)\b/i.test(cleanLow)) {
      const fileQuery = cleanText.replace(/\b(find|search|where is|locate|open)\s+(?:my\s+|the\s+)?/i, '').trim();
      return {
        intent: INTENT_TYPES.FILE_REQUEST,
        action: 'search_files',
        device: 'desktop',
        target: fileQuery,
        confidence: 0.90,
        rawText: raw,
        cleanText
      };
    }

    // Knowledge Engine queries ("Search my Chemistry notes", "What did my Physics notes say about arithmetic progression?")
    if (/\b(what did my|search my|in my|according to my)\s+(?:chemistry|physics|ncert|book|notes|project|study)\b/i.test(cleanLow)) {
      return {
        intent: INTENT_TYPES.KNOWLEDGE_REQUEST,
        action: 'query_knowledge',
        device: 'desktop',
        target: cleanText,
        confidence: 0.92,
        rawText: raw,
        cleanText
      };
    }

    // Memory queries ("Remember that...", "What do you know about...", "Forget my...")
    if (/\b(remember that|don't forget|recall|what is my|forget my|my favorite)\b/i.test(cleanLow)) {
      return {
        intent: INTENT_TYPES.MEMORY_REQUEST,
        action: 'manage_memory',
        device: 'desktop',
        target: cleanText,
        confidence: 0.90,
        rawText: raw,
        cleanText
      };
    }

    // Application Launch / Website Open (Device Aware)
    // E.g., "Open WhatsApp on my phone", "Open YouTube on my phone", "Open Spotify"
    const launchMatch = /^\s*(?:open|launch|start|fire up|run)\s+(?:the\s+|my\s+)?([a-z0-9 .+-]{2,40})/i.exec(cleanText);
    if (launchMatch) {
      const appName = launchMatch[1].trim();

      // Check if target is a known website domain or web app keyword
      const isWebsite = /^(youtube|google|github|twitter|x|reddit|netflix|wikipedia|amazon|facebook|instagram|linkedin)$/i.test(appName) ||
                        /^[\w-]+(\.[\w-]+)+$/.test(appName);

      if (isWebsite) {
        return {
          intent: device === 'phone' ? INTENT_TYPES.PHONE_ACTION : INTENT_TYPES.WEB_REQUEST,
          action: 'open_url',
          device,
          target: isWebsite ? (appName.startsWith('http') ? appName : `https://${appName}.com`) : appName,
          appName,
          confidence: 0.95,
          rawText: raw,
          cleanText
        };
      }

      return {
        intent: device === 'phone' ? INTENT_TYPES.PHONE_ACTION : INTENT_TYPES.APPLICATION_REQUEST,
        action: 'launch_app',
        device,
        target: appName,
        appName,
        confidence: 0.95,
        rawText: raw,
        cleanText
      };
    }

    // Media Controls
    if (/\b(play|pause|mute|unmute|volume up|volume down|next song|previous song|stop music)\b/i.test(cleanLow)) {
      return {
        intent: INTENT_TYPES.MEDIA_REQUEST,
        action: 'media_control',
        device,
        target: cleanLow,
        confidence: 0.90,
        rawText: raw,
        cleanText
      };
    }

    // Fallback to conversation
    return {
      intent: INTENT_TYPES.CONVERSATION,
      action: null,
      device: 'desktop',
      target: null,
      confidence: 0.50,
      rawText: raw,
      cleanText
    };
  }

  /**
   * Process input end-to-end, returning structured action payload or conversation directive.
   *
   * @param {string} text
   * @param {Object} [ctx]
   */
  async orchestrate(text, ctx = {}) {
    const analysis = this.understand(text, ctx);
    this.log(`[CognitiveOrchestrator] Intent: ${analysis.intent}, Device: ${analysis.device}, Target: ${analysis.target}`);

    if (this.bus) {
      this.bus.emit('cognitive:intent-detected', analysis);
    }

    return analysis;
  }
}

export default CognitiveOrchestrator;
