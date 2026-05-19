import axios from 'axios';
import { config, NotifyEvent } from './config/config';
import { log } from './logger';

export interface NotifyPayload {
  event: NotifyEvent;
  title: string;
  body: string;
  fields?: Record<string, string | number>;
}

export class Notifier {
  private discord: string;
  private telegramToken: string;
  private telegramChat: string;
  private enabledEvents: Set<NotifyEvent>;

  constructor() {
    this.discord = config.notify.discordWebhookUrl;
    this.telegramToken = config.notify.telegramBotToken;
    this.telegramChat = config.notify.telegramChatId;
    this.enabledEvents = new Set(config.notify.on);
  }

  isEnabled(event: NotifyEvent): boolean {
    if (!this.enabledEvents.has(event)) return false;
    return Boolean(this.discord) || Boolean(this.telegramToken && this.telegramChat);
  }

  async notify(payload: NotifyPayload): Promise<void> {
    if (!this.isEnabled(payload.event)) return;

    const sends: Promise<void>[] = [];
    if (this.discord) sends.push(this.sendDiscord(payload));
    if (this.telegramToken && this.telegramChat) sends.push(this.sendTelegram(payload));

    const results = await Promise.allSettled(sends);
    for (const r of results) {
      if (r.status === 'rejected') {
        log.warn('Notifier delivery failed', { err: String(r.reason) });
      }
    }
  }

  private async sendDiscord(payload: NotifyPayload): Promise<void> {
    const fieldsBlock = this.formatFields(payload.fields);
    const content = `**${payload.title}**\n${payload.body}${fieldsBlock ? '\n```\n' + fieldsBlock + '\n```' : ''}`;
    await axios.post(this.discord, { content }, { timeout: 5000 });
  }

  private async sendTelegram(payload: NotifyPayload): Promise<void> {
    const fieldsBlock = this.formatFields(payload.fields);
    const text = `*${payload.title}*\n${payload.body}${fieldsBlock ? '\n```\n' + fieldsBlock + '\n```' : ''}`;
    const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
    await axios.post(
      url,
      { chat_id: this.telegramChat, text, parse_mode: 'Markdown' },
      { timeout: 5000 },
    );
  }

  private formatFields(fields?: Record<string, string | number>): string {
    if (!fields) return '';
    return Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n');
  }
}
