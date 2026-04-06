import Database from 'better-sqlite3';
import path from 'node:path';

const LOOKBACK_DAYS = Number(process.env.NUTRITION_METRICS_LOOKBACK_DAYS || 7);
const FAIL_ALERT_THRESHOLD = Number(process.env.NUTRITION_PARSE_FAIL_ALERT_THRESHOLD || 0.35);
const DB_PATH =
  process.env.DB_PATH || process.env.NUTRITION_DB_PATH || path.resolve(process.cwd(), 'data', 'bot.db');

function toPercent(value = 0) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function main() {
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  const rows = db
    .prepare(
      `
      SELECT
        substr(created_at, 1, 10) AS day,
        COUNT(*) AS total,
        SUM(CASE WHEN json_extract(raw_usage_json, '$.ok') = 1 THEN 1 ELSE 0 END) AS ok_count,
        SUM(CASE WHEN json_extract(raw_usage_json, '$.ok') = 0 THEN 1 ELSE 0 END) AS fail_count
      FROM nutrition_usage_records
      WHERE guided_action = 'log_intake_parse_trace'
        AND created_at >= datetime('now', ?)
      GROUP BY day
      ORDER BY day DESC
      `
    )
    .all(`-${Math.max(1, LOOKBACK_DAYS)} days`);
  db.close();

  const normalizedRows = rows.map((row) => {
    const total = Number(row?.total || 0);
    const failCount = Number(row?.fail_count || 0);
    const failRate = total > 0 ? failCount / total : 0;
    return {
      day: String(row?.day || ''),
      total,
      ok_count: Number(row?.ok_count || 0),
      fail_count: failCount,
      fail_rate: toPercent(failRate),
      alert: failRate > FAIL_ALERT_THRESHOLD,
    };
  });

  const latest = normalizedRows[0] || null;
  const payload = {
    db_path: DB_PATH,
    lookback_days: LOOKBACK_DAYS,
    fail_alert_threshold: toPercent(FAIL_ALERT_THRESHOLD),
    rows: normalizedRows,
    latest_alert: Boolean(latest?.alert),
  };
  console.log(JSON.stringify(payload, null, 2));

  if (latest?.alert) {
    process.exitCode = 1;
  }
}

main();
