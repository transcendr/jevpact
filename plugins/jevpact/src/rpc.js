import net from 'node:net';
import { socketPath } from './paths.js';

export function call(message, { timeout = 1500, socket = socketPath() } = {}) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let data = '';
    const timer = setTimeout(() => client.destroy(Object.assign(new Error('Jevpact request timed out'), { code: 'ETIMEDOUT' })), timeout);
    client.once('connect', () => client.write(JSON.stringify(message) + '\n'));
    client.on('data', chunk => {
      data += chunk.toString();
      if (message.method !== 'status' && data.length > 128000) return client.destroy(new Error('Oversized reply'));
      if (!data.includes('\n')) return;
      clearTimeout(timer);
      client.end();
      try {
        const result = JSON.parse(data.split('\n')[0]);
        if (result.error) reject(Object.assign(new Error(result.error), { code: result.error }));
        else resolve(result);
      } catch (e) { reject(e); }
    });
    client.once('error', error => { clearTimeout(timer); reject(error); });
    client.once('end', () => { clearTimeout(timer); if (!data.includes('\n')) reject(new Error('Incomplete reply')); });
  });
}
