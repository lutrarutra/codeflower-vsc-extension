import type { WrapUpNotice } from 'codeflower-ui/client/codeflower.ts';

/** The warning shown when a worker asks its chats to wrap up. */
export function wrapUpMessage(label: string, id: string, notice: WrapUpNotice): string {
  const chats =
    notice.chats === 0
      ? 'No chat was working.'
      : `${notice.chats === 1 ? 'Its working chat was' : `Its ${notice.chats} working chats were`} stopped and asked to save their work and write up where they are.`;
  if (notice.reason === 'quit') {
    return `${label} on ${id}: the code flower client that started it is quitting. ${chats} The sandbox stops when ${notice.chats === 1 ? 'it is' : 'they are'} done, at most in ${notice.minutes} minutes.`;
  }
  const end = new Date(notice.end ?? '').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${label} on ${id}: the job ends at ${end}, in about ${notice.minutes} minutes, and the sandbox stops with it. ${chats}`;
}
