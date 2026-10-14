-- Assistant conversations (docs/ai-assistant.md, D55). Asks, replies, proposed
-- changes and their applied/undone state are kept on the owner's server so
-- every device sees them. Deleting a conversation keeps a tombstone and
-- clears the text of its turns.
CREATE TABLE ai_conversations (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES users(id),
  title text NOT NULL CHECK (char_length(title) <= 80),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz
);
CREATE INDEX ai_conversations_owner_updated ON ai_conversations(owner_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE TABLE ai_conversation_turns (
  id uuid PRIMARY KEY REFERENCES ai_assistant_requests(id),
  owner_id uuid NOT NULL REFERENCES users(id),
  conversation_id uuid NOT NULL REFERENCES ai_conversations(id),
  position integer NOT NULL CHECK (position >= 0),
  ask text CHECK (char_length(ask) <= 1000),
  reply text CHECK (char_length(reply) <= 2000),
  proposals jsonb NOT NULL DEFAULT '[]',
  items jsonb NOT NULL DEFAULT '[]',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_id, position)
);
