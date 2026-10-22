import { UUID_RE, record } from './cache-contract';
import type { CardService } from './card-service';

type Sender = { id?: string; url?: string; tab?: { url?: string } };
export function createMessageHandler(service: CardService, extensionId: string, popupUrl: string) {
  return async (message: unknown, sender: Sender): Promise<unknown> => {
    if (sender.id !== extensionId || !record(message)) throw new Error('拒绝消息来源');
    const popup = sender.url === popupUrl && !sender.tab;
    let site = false;
    try { const u = new URL(sender.url ?? ''); site = u.protocol === 'https:' && !u.port && ['17lands.com', 'www.17lands.com'].includes(u.hostname); } catch { /* Reject. */ }
    if (!popup && !site) throw new Error('拒绝消息来源');
    if (message.type === '17lands-zh:status' && popup && Object.keys(message).length === 1) return service.getStatus();
    if (message.type === '17lands-zh:retry-service' && popup && Object.keys(message).length === 1) return service.getStatus(true);
    if (message.type === '17lands-zh:lookup' && site && Object.keys(message).length === 2 && Array.isArray(message.ids) &&
      message.ids.length > 0 && message.ids.length <= 100 && message.ids.every((id) => typeof id === 'string' && UUID_RE.test(id))) {
      return service.lookup(message.ids);
    }
    if (message.type === '17lands-zh:image' && site && Object.keys(message).length === 3 && typeof message.id === 'string' && UUID_RE.test(message.id) &&
      (message.face === 'front' || message.face === 'back')) return service.image(message.id.toLowerCase(), message.face);
    throw new Error('消息格式无效');
  };
}
