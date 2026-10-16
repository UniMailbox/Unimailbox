CREATE TABLE ai_governance_policy (
  revision INTEGER PRIMARY KEY CHECK(revision>=0),
  mode TEXT NOT NULL CHECK(mode IN ('observe','enforce','paused')),
  monthly_tokens INTEGER NOT NULL CHECK(monthly_tokens>=0),
  daily_tokens INTEGER NOT NULL CHECK(daily_tokens>=0),
  user_monthly_tokens INTEGER NOT NULL CHECK(user_monthly_tokens>=0),
  user_daily_tokens INTEGER NOT NULL CHECK(user_daily_tokens>=0),
  installation_concurrency INTEGER NOT NULL CHECK(installation_concurrency BETWEEN 1 AND 32),
  user_concurrency INTEGER NOT NULL CHECK(user_concurrency BETWEEN 1 AND 8),
  max_input_bytes INTEGER NOT NULL, max_input_tokens INTEGER NOT NULL,
  profile_revision INTEGER, context_tokens INTEGER, overhead_tokens INTEGER,
  verification_reference TEXT, input_price REAL, output_price REAL,
  currency TEXT NOT NULL CHECK(currency IN ('USD','CNY'))
);
INSERT INTO ai_governance_policy VALUES(0,'observe',1000000,250000,100000,25000,4,1,65536,32768,NULL,NULL,NULL,NULL,NULL,NULL,'USD');
CREATE TABLE ai_user_limits (
  policy_revision INTEGER NOT NULL REFERENCES ai_governance_policy(revision),
  user_id TEXT NOT NULL, monthly_tokens INTEGER NOT NULL CHECK(monthly_tokens>=0),
  daily_tokens INTEGER NOT NULL CHECK(daily_tokens>=0),
  PRIMARY KEY(policy_revision,user_id)
);
CREATE TABLE ai_attempts (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  operation_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  policy_revision INTEGER NOT NULL REFERENCES ai_governance_policy(revision),
  configuration_revision INTEGER NOT NULL,
  model TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('submitted','outcome_unknown','completed')),
  content_outcome TEXT CHECK(content_outcome IN ('success','failed')),
  reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens>=0),
  charged_tokens INTEGER NOT NULL DEFAULT 0 CHECK(charged_tokens>=0),
  input_tokens INTEGER CHECK(input_tokens>=0),
  output_tokens INTEGER CHECK(output_tokens>=0),
  provider_request_id TEXT,
  cached_input_tokens INTEGER CHECK(cached_input_tokens>=0),
  reasoning_tokens INTEGER CHECK(reasoning_tokens>=0),
  usage_kind TEXT NOT NULL DEFAULT 'pending' CHECK(usage_kind IN ('pending','reported','conservative','manual')),
  estimated_cost REAL CHECK(estimated_cost>=0),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  settlement_marker TEXT,
  UNIQUE(actor_user_id,operation_hash)
);
CREATE INDEX ai_attempts_created_idx ON ai_attempts(created_at);
CREATE INDEX ai_attempts_actor_created_idx ON ai_attempts(actor_user_id,created_at);
CREATE INDEX ai_attempts_active_idx ON ai_attempts(status,actor_user_id) WHERE status!='completed';
-- Separate tombstones survive response-body expiry and legacy cleanup.
CREATE TABLE ai_legacy_requests (
  actor_user_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  PRIMARY KEY(actor_user_id,idempotency_key)
);
INSERT INTO ai_legacy_requests SELECT actor_id,idempotency_key,request_hash
  FROM idempotency_records WHERE operation='POST /api/v1/mailboxes/:mailboxId/ai-reply';
CREATE TABLE ai_governance_breaker (
  id TEXT PRIMARY KEY CHECK(id='system'),
  reason TEXT,
  policy_revision INTEGER NOT NULL REFERENCES ai_governance_policy(revision) CHECK(policy_revision>=0)
);
INSERT INTO ai_governance_breaker VALUES('system',NULL,0);
INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0042_ai_governance.sql');
