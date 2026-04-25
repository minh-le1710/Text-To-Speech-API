import telegramService from '@/services/TelegramService';

async function main() {
  const updates = await telegramService.getUpdates();
  const chats = new Map<
    number,
    {
      id: number;
      type: string;
      name: string;
      lastText?: string;
    }
  >();

  for (const update of updates) {
    const chat = update.message?.chat;

    if (!chat) {
      continue;
    }

    chats.set(chat.id, {
      id: chat.id,
      type: chat.type,
      name:
        chat.title ??
        chat.username ??
        [chat.first_name, chat.last_name].filter(Boolean).join(' ') ??
        '[unnamed]',
      lastText: update.message?.text,
    });
  }

  if (chats.size === 0) {
    console.log(
      [
        'No Telegram chats found yet.',
        'Open your Telegram bot, send /start or any short message, then run this command again.',
      ].join('\n')
    );
    return;
  }

  console.log('Telegram chats found:\n');

  for (const chat of chats.values()) {
    console.log(`chat_id=${chat.id}`);
    console.log(`type=${chat.type}`);
    console.log(`name=${chat.name}`);

    if (chat.lastText) {
      console.log(`last_text=${chat.lastText}`);
    }

    console.log('');
  }

  console.log('Put the desired chat_id into TELEGRAM_CHAT_ID in .env.');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
