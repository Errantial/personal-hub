import { Help } from './Help';
import { StatusChip } from './StatusChip';
import { nativeAlarms, useNativeAlarms } from '../lib/native-reminders';

const permissionText = {
  granted: 'Allowed',
  denied: 'Blocked in Android settings',
  prompt: 'Not enabled',
  'prompt-with-rationale': 'Not enabled',
  unsupported: 'Not available',
} as const;

/**
 * Native-only device alarm state. Reminders stay in the inbox whether or not
 * the phone can alert, so this reports the alarm path without blocking them.
 */
export function DeviceAlarms() {
  const device = useNativeAlarms();
  if (!device.available) return null;
  const exact = device.exact === 'denied' || device.approximate;
  const canEnable =
    device.permission === 'prompt' ||
    device.permission === 'prompt-with-rationale';
  return (
    <div className="device-alarms">
      <p>
        Device alarms:{' '}
        <StatusChip>
          {device.checked ? permissionText[device.permission] : 'Checking…'}
        </StatusChip>{' '}
        {device.permission === 'granted' &&
          (device.scheduled
            ? `${device.scheduled} scheduled`
            : 'None scheduled')}{' '}
        <Help label="Device alarms">
          Device alarms are scheduled on the phone and ring while the app is
          closed, including after a restart. An approximate alarm can be delayed
          by Android; allow exact alarms for on-time delivery. Reminders remain
          in the inbox either way.
          {device.permission === 'denied' &&
            ' Allow notifications for Personal Hub in Android settings, then check again.'}
        </Help>
      </p>
      {device.permission === 'granted' && exact && (
        <p>
          Timing: <StatusChip>Approximate</StatusChip>{' '}
          <button
            type="button"
            className="secondary-button"
            disabled={device.busy}
            onClick={() => void nativeAlarms.allowExact()}
          >
            Allow exact alarms
          </button>
        </p>
      )}
      {canEnable && (
        <button
          type="button"
          className="secondary-button"
          disabled={device.busy}
          onClick={() => void nativeAlarms.enable()}
        >
          Enable device alarms
        </button>
      )}
      {device.permission === 'denied' && (
        <button
          type="button"
          className="secondary-button"
          disabled={device.busy}
          onClick={() => void nativeAlarms.refresh()}
        >
          Check again
        </button>
      )}
      {device.problem === 'error' && (
        <p role="status" className="form-error">
          Device alarms could not be updated. Reminders remain in the inbox.{' '}
          <button
            type="button"
            className="secondary-button"
            disabled={device.busy}
            onClick={() => void nativeAlarms.reconcile()}
          >
            Retry device alarms
          </button>
        </p>
      )}
      {device.duplicates > 0 && (
        <p role="status" className="form-error">
          One reminder has no device alarm because another reminder uses its
          notification slot.
        </p>
      )}
    </div>
  );
}
