import { EventEmitter } from 'node:events';
import type { WsMessage } from '../../shared/types.ts';

// Everything that changes state publishes here; the WebSocket layer fans it out to dashboards.
class Bus extends EventEmitter {
  publish(msg: WsMessage) {
    this.emit('msg', msg);
  }
  subscribe(fn: (msg: WsMessage) => void) {
    this.on('msg', fn);
    return () => this.off('msg', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
