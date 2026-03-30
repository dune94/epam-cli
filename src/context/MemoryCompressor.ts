import type { LLMProvider, Message } from '../providers/types.js';

export async function compressHistory(
  messages: Message[],
  provider: LLMProvider,
  model: string
): Promise<Message[]> {
  if (messages.length <= 4) return messages;

  const toCompress = messages.slice(0, -4);
  const recent = messages.slice(-4);

  const historyText = toCompress
    .map(m => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${m.role}: ${content}`;
    })
    .join('\n\n');

  try {
    const response = await provider.complete({
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation history concisely, preserving key facts and decisions:\n\n${historyText}`,
        },
      ],
      model,
      stream: false,
    });

    const summary = response.content.find(p => p.type === 'text')?.text ?? historyText;

    return [
      { role: 'user', content: `[Previous conversation summary]: ${summary}` },
      { role: 'assistant', content: 'Understood. I have the context of our previous conversation.' },
      ...recent,
    ];
  } catch {
    // If compression fails, just drop old messages
    return recent;
  }
}
