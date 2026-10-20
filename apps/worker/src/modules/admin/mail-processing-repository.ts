import type { MailProcessingResponse, ResourceMetric } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';

export const MAIL_ANALYTICS_RECORD_LIMIT = 5000;
type Day = { date: string } & Record<string, number | string | null>;
type Spec = {
  id: string;
  label: string;
  unit?: ResourceMetric['unit'];
  aggregation?: ResourceMetric['aggregation'];
  samples?: string;
  empty?: null;
};

/** Aggregate metadata only; never select bodies, subjects, identities, keys or credentials. */
export async function readMailProcessing(
  db: Database,
  days: 7 | 30,
  now: Date,
): Promise<MailProcessingResponse> {
  const endDate = now.toISOString().slice(0, 10);
  const end = new Date(`${endDate}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days);
  const startDate = start.toISOString().slice(0, 10),
    endExclusive = end.toISOString().slice(0, 10);
  const dates = Array.from({ length: days }, (_, i) =>
    new Date(start.getTime() + i * 86400_000).toISOString().slice(0, 10),
  );
  // Inclusive day prefixes support existing SQLite and ISO timestamp formats.
  const columns = {
    messages: 'id,created_at,(raw_object_key IS NOT NULL) AS is_inbound',
    outbound_jobs: 'id,created_at,updated_at,status,error_code,attempts',
    inbound_receipts: 'id,created_at,completed_at,status,attempts,raw_size',
  };
  const cohort = (table: keyof typeof columns) =>
    `SELECT ${columns[table]} FROM ${table} WHERE created_at>=? AND created_at<? ORDER BY created_at LIMIT ${MAIL_ANALYTICS_RECORD_LIMIT + 1}`;
  const groups: MailProcessingResponse['groups'] = [];
  const counts = await db.batch<{ n: number }>(
    (['messages', 'outbound_jobs', 'inbound_receipts'] as const).map((table) =>
      db
        .prepare(`WITH cohort AS (${cohort(table)}) SELECT COUNT(*) n FROM cohort`)
        .bind(startDate, endExclusive),
    ),
  );
  const exceeded = counts.map(
    (result) => (result.results[0]?.n ?? 0) > MAIL_ANALYTICS_RECORD_LIMIT,
  );
  const add = (
    id: MailProcessingResponse['groups'][number]['id'],
    rows: Day[],
    specs: Spec[],
    limited = false,
  ) => {
    groups.push({
      id,
      status: limited ? 'limit_exceeded' : 'ready',
      metrics: limited
        ? []
        : specs.map((spec) => ({
            id: spec.id,
            label: spec.label,
            unit: spec.unit ?? 'count',
            aggregation: spec.aggregation ?? 'sum',
            points: dates.map((date) => {
              const row = rows.find((item) => item.date === date);
              const value = row?.[spec.id];
              return {
                date,
                value: typeof value === 'number' ? value : spec.empty === null ? null : 0,
                ...(spec.samples ? { sampleCount: Number(row?.[spec.samples] ?? 0) } : {}),
              };
            }),
          })),
    });
  };
  let mailRows: Day[] = [];
  if (!exceeded[0]) {
    mailRows = (
      await db
        .prepare(
          `WITH cohort AS (${cohort('messages')})
      SELECT substr(m.created_at,1,10) date,
        COUNT(*) cohort_count,
        SUM(m.is_inbound) received,
        SUM((SELECT COALESCE(SUM(size_bytes),0) FROM inbound_message_attachments a WHERE a.message_id=m.id)) inbound_bytes,
        SUM((SELECT COUNT(*) FROM inbound_message_attachments a WHERE a.message_id=m.id)) inbound_count,
        SUM((SELECT COALESCE(SUM(size_bytes),0) FROM message_attachments a WHERE a.message_id=m.id)) outbound_bytes,
        SUM((SELECT COUNT(*) FROM message_attachments a WHERE a.message_id=m.id)) outbound_count,
        SUM((SELECT COALESCE(SUM(a.size_bytes),0) FROM editor_asset_usages u JOIN editor_assets a ON a.id=u.asset_id WHERE u.resource_type='message' AND u.resource_id=m.id)) hosted_bytes,
        SUM((SELECT COUNT(*) FROM editor_asset_usages u WHERE u.resource_type='message' AND u.resource_id=m.id)) hosted_count
      FROM cohort m GROUP BY date ORDER BY date`,
        )
        .bind(startDate, endExclusive)
        .all<Day>()
    ).results;
  }
  const mailLimited =
    exceeded[0] ||
    mailRows.reduce((sum, row) => sum + Number(row.cohort_count ?? 0), 0) >
      MAIL_ANALYTICS_RECORD_LIMIT;
  add('mail', mailRows, [{ id: 'received', label: 'Retained inbound messages' }], mailLimited);
  add(
    'attachments',
    mailRows,
    [
      { id: 'inbound_bytes', label: 'Decoded inbound attachment bytes', unit: 'bytes' },
      { id: 'inbound_count', label: 'Inbound attachment count' },
      { id: 'outbound_bytes', label: 'Outgoing attachment bytes', unit: 'bytes' },
      { id: 'outbound_count', label: 'Outgoing attachment count' },
      { id: 'hosted_bytes', label: 'Outgoing hosted asset bytes', unit: 'bytes' },
      { id: 'hosted_count', label: 'Outgoing hosted asset count' },
    ],
    mailLimited,
  );
  let jobRows: Day[] = [];
  if (!exceeded[1]) {
    jobRows = (
      await db
        .prepare(
          `WITH cohort AS (${cohort('outbound_jobs')}), timed AS (
      SELECT *, round((julianday(updated_at)-julianday(created_at))*86400000) duration FROM cohort)
      SELECT substr(created_at,1,10) date, COUNT(*) jobs,
        SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) queued,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,
        SUM(CASE WHEN error_code='SEND_OUTCOME_UNKNOWN' THEN 1 ELSE 0 END) unknown,
        SUM(attempts) retries,
        AVG(CASE WHEN status='sent' AND duration>=0 THEN duration END) latency,
        SUM(CASE WHEN status='sent' AND duration>=0 THEN 1 ELSE 0 END) latency_samples
      FROM timed GROUP BY date ORDER BY date`,
        )
        .bind(startDate, endExclusive)
        .all<Day>()
    ).results;
  }
  add(
    'outbound',
    jobRows,
    [
      { id: 'jobs', label: 'Outbound tasks created' },
      { id: 'queued', label: 'Currently queued outbound tasks' },
      { id: 'failed', label: 'Currently failed outbound tasks' },
      { id: 'unknown', label: 'Unknown outbound outcomes' },
      { id: 'retries', label: 'Recorded outbound retry reservations' },
      {
        id: 'latency',
        label: 'Created-to-sent latency',
        unit: 'milliseconds',
        aggregation: 'average',
        samples: 'latency_samples',
        empty: null,
      },
    ],
    exceeded[1] ||
      jobRows.reduce((sum, row) => sum + Number(row.jobs ?? 0), 0) > MAIL_ANALYTICS_RECORD_LIMIT,
  );
  let receiptRows: Day[] = [];
  if (!exceeded[2]) {
    receiptRows = (
      await db
        .prepare(
          `WITH cohort AS (${cohort('inbound_receipts')}), timed AS (
      SELECT *, round((julianday(completed_at)-julianday(created_at))*86400000) duration FROM cohort)
      SELECT substr(created_at,1,10) date, COUNT(*) samples, SUM(raw_size) raw_bytes, MAX(raw_size) raw_max,
        SUM(CASE WHEN status!='completed' THEN 1 ELSE 0 END) pending,
        SUM(max(attempts-1,0)) retries,
        AVG(CASE WHEN status='completed' AND duration>=0 THEN duration END) latency,
        SUM(CASE WHEN status='completed' AND duration>=0 THEN 1 ELSE 0 END) latency_samples
      FROM timed GROUP BY date ORDER BY date`,
        )
        .bind(startDate, endExclusive)
        .all<Day>()
    ).results;
  }
  add(
    'receipts',
    receiptRows,
    [
      { id: 'samples', label: 'Retained receipt samples', empty: null },
      { id: 'raw_bytes', label: 'Raw email sample bytes', unit: 'bytes', empty: null },
      {
        id: 'raw_max',
        label: 'Largest raw email sample',
        unit: 'bytes',
        aggregation: 'max',
        empty: null,
      },
      { id: 'pending', label: 'Unfinished receipt samples', empty: null },
      { id: 'retries', label: 'Additional inbound processing claims', empty: null },
      {
        id: 'latency',
        label: 'Receipt completion latency',
        unit: 'milliseconds',
        aggregation: 'average',
        samples: 'latency_samples',
        empty: null,
      },
    ],
    exceeded[2] ||
      receiptRows.reduce((sum, row) => sum + Number(row.samples ?? 0), 0) >
        MAIL_ANALYTICS_RECORD_LIMIT,
  );
  return {
    source: 'application_metadata',
    generatedAt: now.toISOString(),
    startDate,
    endDate,
    days,
    groups,
  };
}
