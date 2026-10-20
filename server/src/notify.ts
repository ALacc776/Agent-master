import { execFile } from 'node:child_process';
import { settings } from './ctx.ts';

// Desktop notification (macOS) plus optional ntfy.sh push to a phone.
export function notify(title: string, body: string) {
  const s = settings();
  if (s.macNotifications && process.platform === 'darwin') {
    const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 220);
    execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
  }
  if (s.ntfyTopic) {
    fetch(`https://ntfy.sh/${encodeURIComponent(s.ntfyTopic)}`, {
      method: 'POST',
      headers: { Title: title.replace(/[^\x20-\x7e]/g, '') },
      body: body.slice(0, 1000),
    }).catch(() => {});
  }
}
