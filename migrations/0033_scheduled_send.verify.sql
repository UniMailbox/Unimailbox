SELECT '0033_scheduled_at' AS assertion, COUNT(*) = 1 AS pass FROM pragma_table_info('outbound_jobs') WHERE name='scheduled_at' AND type='TEXT' AND "notnull"=0;
SELECT '0033_mailbox_id' AS assertion, COUNT(*) = 1 AS pass FROM pragma_table_info('outbound_jobs') WHERE name='mailbox_id' AND type='TEXT' AND "notnull"=0;
SELECT '0033_mailbox_fk' AS assertion, COUNT(*) = 1 AS pass FROM pragma_foreign_key_list('outbound_jobs') WHERE "from"='mailbox_id' AND "table"='mailboxes' AND "to"='id';
SELECT '0033_revision' AS assertion, COUNT(*) = 1 AS pass FROM pragma_table_info('outbound_jobs') WHERE name='schedule_revision' AND type='INTEGER' AND "notnull"=1 AND dflt_value='0';
SELECT '0033_tracking' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name='0033_scheduled_send.sql';
PRAGMA foreign_key_check;
