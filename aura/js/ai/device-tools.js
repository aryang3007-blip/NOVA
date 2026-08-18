/**
 * AURA :: Device-Targeted Tools
 * ----------------------------
 * Tools that can target paired devices (phones, companion PCs, etc)
 *
 * @module ai/device-tools
 */

export const DEVICE_TOOLS = {
  device_open_app: {
    name: 'device_open_app',
    description: 'Open an app on a paired device (phone, companion PC, etc).',
    action: 'device_send_action',
    parameters: {
      device: { type: 'string', required: true, description: 'Target device: "phone", "my phone", "android-001", etc' },
      application: { type: 'string', required: true, description: 'App to open: "YouTube", "WhatsApp", etc' },
    },
    map: p => ({ device: p.device, action: 'open_app', params: { app: p.application } }),
  },
  device_open_url: {
    name: 'device_open_url',
    description: 'Open a website on a paired device.',
    action: 'device_send_action',
    parameters: {
      device: { type: 'string', required: true, description: 'Target device' },
      url: { type: 'string', required: true, description: 'Website URL' },
    },
    map: p => ({ device: p.device, action: 'open_url', params: { url: p.url } }),
  },
  device_send_notification: {
    name: 'device_send_notification',
    description: 'Send a notification to a paired device.',
    action: 'device_send_action',
    parameters: {
      device: { type: 'string', required: true, description: 'Target device' },
      title: { type: 'string', required: true, description: 'Notification title' },
      message: { type: 'string', required: false, description: 'Notification body' },
    },
    map: p => ({
      device: p.device,
      action: 'show_notification',
      params: { title: p.title, body: p.message || '' },
    }),
  },
  device_list: {
    name: 'device_list',
    description: 'List all paired devices and their status.',
    action: 'device_list_action',
    parameters: {},
    map: () => ({}),
  },
};

export const DEVICE_TOOL_NAMES = Object.keys(DEVICE_TOOLS);

export default { DEVICE_TOOLS, DEVICE_TOOL_NAMES };
