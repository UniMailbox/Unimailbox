SELECT '0041_thread_root_column' AS assertion, count(*)=1 AS pass FROM pragma_table_info('mailbox_messages') WHERE name='thread_root';
SELECT '0041_thread_root_index' AS assertion, count(*)=1 AS pass FROM sqlite_master WHERE type='index' AND name='mailbox_messages_mailbox_thread_idx';
SELECT '0041_thread_root_triggers' AS assertion, count(*)=3 AS pass FROM sqlite_master WHERE type='trigger' AND name IN ('mailbox_message_thread_insert','mailbox_message_thread_rebind','message_thread_headers_update');
SELECT '0041_thread_roots_match_headers' AS assertion, count(*)=0 AS pass FROM mailbox_messages mm JOIN messages m ON m.id=mm.message_id WHERE mm.thread_root IS NOT (CASE
  WHEN m.thread_id IS NOT NULL AND m.thread_id != '' THEN m.thread_id
  WHEN instr(m.references_header, '<') > 0
       AND instr(m.references_header, '>') > instr(m.references_header, '<') THEN
    substr(m.references_header, instr(m.references_header, '<'),
           instr(m.references_header, '>') - instr(m.references_header, '<') + 1)
  WHEN m.in_reply_to_header IS NOT NULL AND m.in_reply_to_header != '' THEN m.in_reply_to_header
  ELSE NULLIF(m.message_id_header, '')
END);
SELECT '0041_registered' AS assertion, count(*)=1 AS pass FROM d1_migrations WHERE name='0041_mailbox_thread_roots.sql';
