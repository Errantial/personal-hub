-- No retroactive provenance claims for previously imported mail.
ALTER TABLE email_messages ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE email_messages ADD COLUMN text_origin text CHECK (text_origin = 'message-body-v1');
