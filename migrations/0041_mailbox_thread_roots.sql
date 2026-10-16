-- Preserve existing root precedence; normalize per mailbox to bound tenant-scoped reads.
ALTER TABLE mailbox_messages ADD COLUMN thread_root TEXT;
UPDATE mailbox_messages SET thread_root = (SELECT CASE
  WHEN m.thread_id IS NOT NULL AND m.thread_id != '' THEN m.thread_id
  WHEN instr(m.references_header, '<') > 0
       AND instr(m.references_header, '>') > instr(m.references_header, '<') THEN
    substr(m.references_header, instr(m.references_header, '<'),
           instr(m.references_header, '>') - instr(m.references_header, '<') + 1)
  WHEN m.in_reply_to_header IS NOT NULL AND m.in_reply_to_header != '' THEN m.in_reply_to_header
  ELSE NULLIF(m.message_id_header, '')
END FROM messages m WHERE m.id = mailbox_messages.message_id);
CREATE INDEX mailbox_messages_mailbox_thread_idx ON mailbox_messages(mailbox_id, thread_root);
CREATE TRIGGER mailbox_message_thread_insert AFTER INSERT ON mailbox_messages BEGIN
  UPDATE mailbox_messages SET thread_root = (SELECT CASE
  WHEN m.thread_id IS NOT NULL AND m.thread_id != '' THEN m.thread_id
  WHEN instr(m.references_header, '<') > 0
       AND instr(m.references_header, '>') > instr(m.references_header, '<') THEN
    substr(m.references_header, instr(m.references_header, '<'),
           instr(m.references_header, '>') - instr(m.references_header, '<') + 1)
  WHEN m.in_reply_to_header IS NOT NULL AND m.in_reply_to_header != '' THEN m.in_reply_to_header
  ELSE NULLIF(m.message_id_header, '')
END FROM messages m WHERE m.id = NEW.message_id) WHERE id = NEW.id;
END;
CREATE TRIGGER mailbox_message_thread_rebind AFTER UPDATE OF message_id ON mailbox_messages BEGIN
  UPDATE mailbox_messages SET thread_root = (SELECT CASE
  WHEN m.thread_id IS NOT NULL AND m.thread_id != '' THEN m.thread_id
  WHEN instr(m.references_header, '<') > 0
       AND instr(m.references_header, '>') > instr(m.references_header, '<') THEN
    substr(m.references_header, instr(m.references_header, '<'),
           instr(m.references_header, '>') - instr(m.references_header, '<') + 1)
  WHEN m.in_reply_to_header IS NOT NULL AND m.in_reply_to_header != '' THEN m.in_reply_to_header
  ELSE NULLIF(m.message_id_header, '')
END FROM messages m WHERE m.id = NEW.message_id) WHERE id = NEW.id;
END;
CREATE TRIGGER message_thread_headers_update AFTER UPDATE OF thread_id, references_header, in_reply_to_header, message_id_header ON messages BEGIN
  UPDATE mailbox_messages SET thread_root = CASE
  WHEN NEW.thread_id IS NOT NULL AND NEW.thread_id != '' THEN NEW.thread_id
  WHEN instr(NEW.references_header, '<') > 0
       AND instr(NEW.references_header, '>') > instr(NEW.references_header, '<') THEN
    substr(NEW.references_header, instr(NEW.references_header, '<'),
           instr(NEW.references_header, '>') - instr(NEW.references_header, '<') + 1)
  WHEN NEW.in_reply_to_header IS NOT NULL AND NEW.in_reply_to_header != '' THEN NEW.in_reply_to_header
  ELSE NULLIF(NEW.message_id_header, '')
END WHERE message_id = NEW.id;
END;
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0041_mailbox_thread_roots.sql');
