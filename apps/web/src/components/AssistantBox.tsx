import { useAssistantSettings } from './AssistantComposer';
import './Assistant.css';

export const assistantHelp = `Describe tasks or events to add or change. The assistant proposes changes and nothing is saved until you apply them. It sees the titles and times of your open tasks and one-time events in the next 30 days, not notes, repeating events, source-linked items, unknown label history, or anything you labeled Personal or Restricted. Follow-ups also resend your earlier asks and replies in the conversation. With Use mail ticked, the assistant may search the subjects and senders of mail you allow and read up to five messages; each answer lists what was sent. Restricted mail is never sent, and Personal mail only if allowed in Settings › AI. Such asks can take up to three calls. Requests go to OpenRouter and count against your AI spending limits. Conversations are kept on your server until you delete them.`;

export { useAssistantSettings };
