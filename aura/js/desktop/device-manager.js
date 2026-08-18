/**
 * NOVA :: Device Manager & Transport Abstraction
 * ---------------------------------------------
 * Abstraction layer for multi-device management (Desktop, Phone Companion).
 * Supports transport adapters (HTTP long-polling, WebSockets), pairing,
 * authentication, declared capabilities, and bidirectional command dispatch.
 *
 * @module desktop/device-manager
 */

export class DeviceTransportAdapter {
  constructor(name = 'abstract') {
    this.name = name;
    this.connected = false;
  }

  async connect(config) {
    throw new Error('connect() not implemented');
  }

  async send(deviceId, action) {
    throw new Error('send() not implemented');
  }

  async poll(deviceId) {
    throw new Error('poll() not implemented');
  }

  disconnect() {
    this.connected = false;
  }
}

export class LongPollingTransportAdapter extends DeviceTransportAdapter {
  constructor(baseUrl = '') {
    super('long-polling');
    this.baseUrl = baseUrl;
  }

  async send(deviceId, action, token) {
    const res = await fetch(`${this.baseUrl}/api/devices/enqueue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ deviceId, action }),
    });
    return res.json();
  }

  async poll(deviceId, token) {
    const res = await fetch(`${this.baseUrl}/api/devices/poll?device_id=${encodeURIComponent(deviceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    return res.json();
  }
}

export class DeviceManager {
  /**
   * @param {Object} [opts]
   * @param {Object} [opts.bus]
   * @param {DeviceTransportAdapter} [opts.transport]
   */
  constructor(opts = {}) {
    this.bus = opts.bus || null;
    this.transport = opts.transport || new LongPollingTransportAdapter();
    this.devices = new Map(); // deviceId -> Device object
    this.trustedDevices = new Set();
  }

  /**
   * Register or update a connected companion device
   */
  registerDevice(deviceInfo) {
    if (!deviceInfo?.id) return false;
    const existing = this.devices.get(deviceInfo.id) || {};
    const updated = {
      id: deviceInfo.id,
      name: deviceInfo.name || 'Mobile Companion',
      platform: deviceInfo.platform || 'android',
      kind: deviceInfo.kind || 'phone',
      capabilities: Array.isArray(deviceInfo.capabilities) ? deviceInfo.capabilities : ['open_url', 'show_notification', 'vibrate'],
      status: deviceInfo.status || 'connected',
      trusted: this.trustedDevices.has(deviceInfo.id) || !!deviceInfo.trusted,
      lastSeen: Date.now(),
      battery: deviceInfo.battery ?? null,
      ...existing,
      ...deviceInfo,
    };
    this.devices.set(deviceInfo.id, updated);
    this.bus?.emit('devices:updated', Array.from(this.devices.values()));
    return updated;
  }

  getDevice(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  listDevices() {
    return Array.from(this.devices.values());
  }

  listPairedPhones() {
    return this.listDevices().filter(d => d.kind === 'phone' && d.status === 'connected');
  }

  /**
   * Dispatch a structured action to a targeted device
   */
  async dispatchToDevice(deviceId, action) {
    const dev = this.getDevice(deviceId);
    if (!dev) {
      return { ok: false, message: `Device "${deviceId}" is not paired or connected.` };
    }

    // Verify capability
    const reqCap = action.action === 'launch_app' ? 'open_url' : action.action;
    if (dev.capabilities && !dev.capabilities.includes(reqCap) && !dev.capabilities.includes('open_url')) {
      return { ok: false, message: `Device "${dev.name}" does not support capability "${reqCap}".` };
    }

    try {
      const res = await this.transport.send(deviceId, action, dev.token || '');
      this.bus?.emit('devices:action-sent', { deviceId, action, result: res });
      return { ok: true, message: `Command sent to ${dev.name}.`, result: res };
    } catch (e) {
      return { ok: false, message: `Failed to transmit command to ${dev.name}: ${e.message}` };
    }
  }

  setTrust(deviceId, trusted = true) {
    if (trusted) this.trustedDevices.add(deviceId);
    else this.trustedDevices.delete(deviceId);
    const d = this.devices.get(deviceId);
    if (d) d.trusted = trusted;
  }
}

export default DeviceManager;
