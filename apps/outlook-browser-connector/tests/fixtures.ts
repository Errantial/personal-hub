/** Synthetic Outlook Web list/reading-pane shapes. No private mail data. */
export const folderRows = [
  { href: '/mail/inbox', name: 'Inbox' },
  { href: 'https://outlook.office.com/mail/sentitems', name: 'Sent Items' },
  { href: 'https://outlook.office.com/mail/syntheticFolder01', name: 'Course' },
  {
    href: 'https://evil.example/mail/syntheticFolder02',
    name: 'Foreign ignored',
  },
  { href: '/mail/id', name: 'Reserved ignored' },
];

export const listRows = [
  {
    href: '/mail/inbox/id/syntheticMessage0001',
    subject: 'Synthetic welcome notice',
    sender: 'Synthetic Advisor <advisor@example.test>',
    senderAddress: 'mailto:advisor@example.test',
    snippet: 'A short synthetic preview.',
    receivedAt: '2026-11-01T15:30:00Z',
    conversationId: 'syntheticConversation0001',
  },
  {
    href: 'https://outlook.office.com/mail/inbox/id/syntheticMessage0002',
    subject: 'Synthetic duplicate row',
    sender: 'Synthetic Advisor <advisor@example.test>',
    senderAddress: 'mailto:advisor@example.test',
    snippet: 'Duplicate DOM row.',
    receivedAt: '2026-11-02T09:00:00Z',
    conversationId: 'syntheticConversation0002',
  },
  {
    href: '/mail/inbox/id/syntheticMessage0002',
    subject: 'Synthetic duplicate row',
    sender: 'Synthetic Advisor <advisor@example.test>',
    senderAddress: 'mailto:advisor@example.test',
    snippet: 'Duplicate DOM row.',
    receivedAt: '2026-11-02T09:00:00Z',
    conversationId: 'syntheticConversation0002',
  },
];

export const readingPanes = new Map([
  [
    'syntheticMessage0001',
    {
      subject: 'Synthetic welcome notice',
      sender: 'Synthetic Advisor <advisor@example.test>',
      senderAddress: 'mailto:advisor@example.test',
      receivedAt: '2026-11-01T15:30:00Z',
      bodyText:
        'Hello from a synthetic message.\n\nThis body is plain text only.',
      conversationId: 'syntheticConversation0001',
    },
  ],
  [
    'syntheticMessage0002',
    {
      subject: 'Synthetic duplicate row',
      sender: 'Synthetic Advisor <advisor@example.test>',
      senderAddress: 'mailto:advisor@example.test',
      receivedAt: '2026-11-02T09:00:00Z',
      bodyText: 'Duplicate synthetic body.',
      conversationId: 'syntheticConversation0002',
    },
  ],
]);
