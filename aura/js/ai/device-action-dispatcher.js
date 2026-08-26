/**
 * AURA :: Device Action Dispatcher
 * ---------------------------------
 * Routes device-targeted actions to the device gateway.
 * Validates device is online and has the capability.
 *
 * @module ai/device-action-dispatcher
 */

import { bus, EV } from '../core/bus.js';

// Layer rule: js/ai (L4) must not import js/ui (L6). Notifications cross the
// boundary as a bus event; js/ui/dev-notify.js subscribes and renders them.
const notify = (opts) => bus.emit('ui:notify', opts);

/**
 * Map of device action names to handler functions.
 * Each handler receives (params) and returns a promise.
 */
const DEVICE_ACTIONS = {};

/**
 * Register a device action handler.
 * @param {string} action - action name
 * @param {Function} handler - async (params) => result
 */
export function registerDeviceAction(action, handler) {
  DEVICE_ACTIONS[action] = handler;
}

/**
 * Dispatch a device action.
 * @param {string} action - e.g. 'device_send_action', 'device_list_action'
 * @param {object} params - action parameters
 * @param {object} opts - { devices, bridge }
 * @returns {Promise<{ok:boolean, message:string, ...}>}
 */
export async function dispatchDeviceAction(action, params, { devices = null, bridge = null } = {}) {
  const startTime = performance.now();
  const traceLog = [];

  function log(msg, data = null) {
    const entry = { at: performance.now() - startTime, msg, data };
    traceLog.push(entry);
    bus.emit(EV.LOG, { text: `[device-dispatcher] ${msg}`, kind: 'info', data });
  }

  log('Dispatch start', { action, params });

  try {
    // Check if it's a registered device action
    if (DEVICE_ACTIONS[action]) {
      log('Using registered handler');
      const result = await DEVICE_ACTIONS[action](params);
      log('Handler result', result);
      return result;
    }

    // Built-in device actions
    if (action === 'device_send_action') {
      return await handleDeviceSendAction(params, { devices, bridge, log, traceLog });
    }

    if (action === 'device_list_action') {
      return await handleDeviceList(params, { devices, log });
    }

    log('Unknown action', action);
    return {
      ok: false,
      message: `Unknown device action: ${action}`,
      code: 'unknown_action',
    };
  } catch (err) {
    log('Exception', { message: err.message, stack: err.stack });
    notify({
      type: 'error',
      title: 'Device Dispatch',
      message: err.message.slice(0, 60),
      trace: `Action: ${action}\n\nTrace:\n${traceLog.map(e => `[${e.at.toFixed(0)}ms] ${e.msg}`).join('\n')}\n\nStack: ${err.stack}`,
      duration: 5000,
    });
    return {
      ok: false,
      message: err.message,
      code: 'execution_failed',
    };
  }
}

/**
 * Handle device_send_action: queue an action for a device.
 */
async function handleDeviceSendAction(
  params,
  { devices, bridge, log, traceLog }
) {
  const { device: deviceRef, action: targetAction, params: targetParams } = params;

  log('handleDeviceSendAction', { deviceRef, targetAction });

  if (!devices) {
    log('No devices module available');
    notify({
      type: 'error',
      title: 'No Device Gateway',
      message: 'Device gateway not available',
      trace: 'Ensure devices.py is imported and available',
      duration: 3000,
    });
    return {
      ok: false,
      message: 'Device gateway not available.',
      code: 'not_available',
    };
  }

  if (!deviceRef) {
    log('No device reference provided');
    return {
      ok: false,
      message: 'No device specified.',
      code: 'invalid_parameters',
    };
  }

  // Map device reference to actual ID
  log('Resolving device', { ref: deviceRef });
  const deviceResolution = devices.resolve(deviceRef);
  const [deviceId, resErr] = deviceResolution;

  if (resErr) {
    log('Device resolution failed', resErr);
    notify({
      type: 'warn',
      title: 'Device Not Found',
      message: resErr.slice(0, 60),
      trace: `Trace log:\n${traceLog.map(e => `[${e.at.toFixed(0)}ms] ${e.msg}`).join('\n')}\n\nError: ${resErr}`,
      duration: 4000,
    });
    return {
      ok: false,
      message: resErr,
      code: 'device_not_found',
    };
  }

  log('Device resolved', { id: deviceId });

  // Send action to device
  const result = devices.send_action(deviceId, targetAction, targetParams);
  log('send_action result', result);

  if (result.ok) {
    const deviceName = (result.device?.name || result.deviceId || deviceId);
    notify({
      type: 'success',
      title: 'Device Action Queued',
      message: `${targetAction} → ${deviceName}`,
      trace: `Trace log:\n${traceLog.map(e => `[${e.at.toFixed(0)}ms] ${e.msg}`).join('\n')}\n\nResult:\n${JSON.stringify(result, null, 2)}`,
      duration: 2500,
    });

    bus.emit('device:action-queued', {
      action: targetAction,
      device: deviceId,
      deviceName,
      params: targetParams,
      actionId: result.actionId,
    });
  } else {
    notify({
      type: 'error',
      title: 'Device Action Failed',
      message: (result.message || 'Unknown error').slice(0, 60),
      trace: `Trace log:\n${traceLog.map(e => `[${e.at.toFixed(0)}ms] ${e.msg}`).join('\n')}\n\nError:\n${JSON.stringify(result, null, 2)}`,
      duration: 4000,
    });

    bus.emit('device:action-failed', {
      action: targetAction,
      device: deviceId,
      reason: result.message,
      result,
    });
  }

  return result;
}

/**
 * Handle device_list_action: list all paired devices.
 */
async function handleDeviceList(params, { devices, log }) {
  log('handleDeviceList');

  if (!devices) {
    return {
      ok: false,
      message: 'Device gateway not available.',
      code: 'not_available',
    };
  }

  const status = devices.status();
  log('Device list', status);

  return {
    ok: status.ok,
    message: status.message,
    devices: status.devices || [],
    count: status.count || 0,
    connected: status.connected || 0,
  };
}

export default { dispatchDeviceAction, registerDeviceAction };
