SELECT '0037_heartbeat_tables' AS assertion, COUNT(*) = 2 AS pass FROM sqlite_master WHERE type='table' AND name IN ('maintenance_heartbeats', 'maintenance_heartbeat_failures');
SELECT '0037_heartbeat_cadences' AS assertion, COUNT(*) = 3 AS pass FROM maintenance_heartbeats WHERE cadence IN ('frequent', 'hourly', 'daily');
SELECT '0037_heartbeat_failures_consistent' AS assertion, COUNT(*) = 0 AS pass FROM maintenance_heartbeats h WHERE h.failed_count != (SELECT COUNT(*) FROM maintenance_heartbeat_failures f WHERE f.cadence = h.cadence);
SELECT '0037_heartbeat_registered' AS assertion, COUNT(*) = 1 AS pass FROM d1_migrations WHERE name='0037_maintenance_heartbeats.sql';
