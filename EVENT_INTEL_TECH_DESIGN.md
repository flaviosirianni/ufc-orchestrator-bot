# Event Intel + Proyecciones (Technical Design)

Fecha: 2026-03-07  
Estado: propuesta implementable (sin tocar logica de apuestas en vivo)

## 1) Objetivo

Agregar un subsistema continuo de inteligencia de evento que:

- Detecte siempre el proximo evento UFC (numerado o Fight Night).
- Monitoree noticias relevantes de peleadores de peleas estelares.
- Mantenga proyecciones por pelea con confianza y trazabilidad de cambios.
- Permita alertas ON/OFF por usuario.
- Exponer UX via botones:
  - `Proyecciones para el evento`
  - `Ultimas novedades`
  - `Alertas noticias ON/OFF` (en `Config`)

## 2) Alcance (fase actual)

Incluye:

- Modelo de datos (SQLite).
- Jobs/schedulers de monitoreo.
- Contratos de salida para wizard y menu Telegram.
- Reglas de relevancia, dedupe, confianza y alertas.

No incluye:

- Ejecucion automatica de apuestas.
- Mutaciones live del ledger disparadas por noticias.

## 3) Arquitectura propuesta

Componentes:

1. `NextEventTracker`
- Reconcilia proximo evento UFC y pelea estelar/main card.
- Guarda snapshot de evento monitoreado.

2. `FighterNewsMonitor`
- Busca noticias por peleador (fuentes web) en cadencia definida.
- Clasifica impacto: `high|medium|low`.
- Dedup por URL + hash normalizado de contenido.

3. `ProjectionEngine`
- Genera/actualiza proyeccion por pelea (winner + metodo opcional + confianza).
- Corre en cadencia diaria y tambien por trigger de noticia `high`.
- Guarda snapshots con razon de cambio.

4. `AlertDispatcher`
- Envia alerta Telegram solo si:
  - hay noticia `high` nueva, o
  - cambia pick, o
  - cambia confianza por encima de umbral.
- Respeta preferencia por usuario (`enabled/disabled`).

## 4) Modelo de datos (SQLite)

### 4.1 `event_watch_state`

Una fila activa por `watch_key='next_event'`.

```sql
CREATE TABLE IF NOT EXISTS event_watch_state (
  watch_key TEXT PRIMARY KEY,
  event_id TEXT,
  event_name TEXT NOT NULL,
  event_date_utc TEXT,
  event_status TEXT, -- scheduled|in_progress|completed|unknown
  source_primary TEXT,
  source_secondary TEXT,
  main_card_json TEXT NOT NULL, -- [{fight_id, fighter_a, fighter_b}]
  monitored_fighters_json TEXT NOT NULL, -- [fighter_name...]
  last_reconciled_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### 4.2 `fighter_news_items`

```sql
CREATE TABLE IF NOT EXISTS fighter_news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  fighter_slug TEXT NOT NULL,
  fighter_name_display TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  source_domain TEXT,
  published_at TEXT,
  fetched_at TEXT NOT NULL,
  summary TEXT,
  impact_level TEXT NOT NULL, -- high|medium|low
  impact_score REAL NOT NULL, -- 0..100
  confidence_score REAL NOT NULL, -- 0..100
  tags_json TEXT, -- ["injury","weight-cut","camp-change",...]
  content_hash TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  is_relevant INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_news_dedupe_key
  ON fighter_news_items (dedupe_key);
CREATE INDEX IF NOT EXISTS idx_news_event_fighter_time
  ON fighter_news_items (event_id, fighter_slug, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_impact_time
  ON fighter_news_items (impact_level, fetched_at DESC);
```

`dedupe_key` recomendado: `sha256(normalized_url + normalized_title + published_day)`.

### 4.3 `fight_projection_snapshots`

```sql
CREATE TABLE IF NOT EXISTS fight_projection_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  fight_id TEXT NOT NULL,
  fighter_a TEXT NOT NULL,
  fighter_b TEXT NOT NULL,
  predicted_winner TEXT, -- fighter_a|fighter_b|no_pick
  predicted_method TEXT, -- decision|ko_tko|submission|unknown
  confidence_pct REAL NOT NULL, -- 0..100
  key_factors_json TEXT NOT NULL, -- bullets
  relevant_news_ids_json TEXT, -- [news_id...]
  reasoning_version TEXT NOT NULL,
  changed_from_prev INTEGER NOT NULL DEFAULT 0,
  change_summary TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projection_event_fight_time
  ON fight_projection_snapshots (event_id, fight_id, created_at DESC);
```

### 4.4 `user_intel_prefs`

```sql
CREATE TABLE IF NOT EXISTS user_intel_prefs (
  telegram_user_id TEXT PRIMARY KEY,
  news_alerts_enabled INTEGER NOT NULL DEFAULT 1,
  alert_min_impact TEXT NOT NULL DEFAULT 'high', -- high|medium|low
  confidence_delta_threshold REAL NOT NULL DEFAULT 8,
  updated_at TEXT NOT NULL
);
```

### 4.5 `intel_alert_dispatch_log`

```sql
CREATE TABLE IF NOT EXISTS intel_alert_dispatch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_user_id TEXT NOT NULL,
  alert_type TEXT NOT NULL, -- news_high|projection_changed|confidence_delta
  event_id TEXT NOT NULL,
  fight_id TEXT,
  news_id INTEGER,
  projection_snapshot_id INTEGER,
  dedupe_key TEXT NOT NULL,
  dispatched_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_alert_dispatch_dedupe
  ON intel_alert_dispatch_log (telegram_user_id, dedupe_key);
```

## 5) Jobs / Scheduler

## 5.1 `eventDiscoveryJob`

- Cadencia base: cada 6h.
- Responsabilidad: actualizar `event_watch_state` con proximo evento.
- Trigger adicional: al detectar cambio de evento o card, forzar corridas de news/projections.

## 5.2 `fighterNewsScanJob`

- Cadencia recomendada:
  - Base: cada 8h (3 veces/dia).
  - T-72h a evento: cada 4h.
  - T-24h a evento: cada 2h.
- Input: peleadores en `event_watch_state.main_card_json`.
- Output: inserta en `fighter_news_items` (dedupe + scoring).

## 5.3 `projectionRefreshJob`

- Cadencia:
  - Base: 1 vez/dia.
  - Trigger: noticia `impact_level='high'`.
- Output: `fight_projection_snapshots`.

## 5.4 `alertDispatchJob`

- Cadencia: cada 10 min.
- Regla: envia solo cambios relevantes y no duplicados.
- Respeta `user_intel_prefs.news_alerts_enabled`.

## 6) Contratos de salida (wizard/menu)

## 6.1 `get_event_projections`

Input:

```json
{ "event_scope": "next", "limit": 8 }
```

Output:

```json
{
  "ok": true,
  "event": { "eventId": "ufc_326", "eventName": "UFC 326", "eventDateUtc": "2026-03-14" },
  "projections": [
    {
      "fightId": "fight_1",
      "fighterA": "A",
      "fighterB": "B",
      "predictedWinner": "A",
      "predictedMethod": "decision",
      "confidencePct": 64,
      "keyFactors": ["..."],
      "relevantNews": [{ "newsId": 123, "impact": "high", "title": "...", "url": "..." }],
      "lastUpdatedAt": "2026-03-07T18:00:00Z",
      "changedFromPrevious": true,
      "changeSummary": "Sube confianza +9 por noticia de camp lesionado."
    }
  ]
}
```

## 6.2 `get_latest_relevant_news`

Input:

```json
{ "event_scope": "next", "limit": 12, "min_impact": "medium" }
```

Output:

```json
{
  "ok": true,
  "event": { "eventId": "ufc_326", "eventName": "UFC 326" },
  "items": [
    {
      "newsId": 123,
      "fighterName": "Fighter X",
      "impactLevel": "high",
      "impactScore": 87,
      "title": "...",
      "summary": "...",
      "url": "...",
      "publishedAt": "...",
      "fetchedAt": "..."
    }
  ]
}
```

## 6.3 `set_news_alerts`

Input:

```json
{ "enabled": true, "minImpact": "high", "confidenceDeltaThreshold": 8 }
```

Output:

```json
{
  "ok": true,
  "prefs": {
    "newsAlertsEnabled": true,
    "alertMinImpact": "high",
    "confidenceDeltaThreshold": 8
  }
}
```

## 7) Cambios de menu Telegram (propuestos)

## 7.1 Menu principal

- Agregar boton `Proyecciones` (`qa:event_projections`).
- Agregar boton `Ultimas novedades` (`qa:latest_news`).

## 7.2 Menu Config

- Agregar boton `Alertas noticias` (`act:cfg_news_alerts_toggle`).
- Opcional fase 2: `Impacto minimo alertas` (`act:cfg_alert_impact`).

## 7.3 Flujos UX

- `qa:event_projections`: responde resumen por pelea con confianza y cambios recientes.
- `qa:latest_news`: responde top novedades relevantes; si no hay, mensaje explicito "sin novedades relevantes desde X".
- `act:cfg_news_alerts_toggle`: toggle ON/OFF + confirmacion estado actual.

## 8) Reglas de negocio y guardrails

- Nunca afirmar lesion/cancelacion sin fuente confiable.
- Si hay conflicto de fuentes, marcar incertidumbre y no disparar cambio fuerte de proyeccion.
- Alertas deduplicadas por usuario y evento.
- No mezclar esto con ejecucion de apuestas en ledger en esta fase.

## 9) Fases de implementacion sugeridas

1. Persistencia + jobs base (`eventDiscoveryJob`, `fighterNewsScanJob`) + `qa:latest_news`.
2. `ProjectionEngine` + `qa:event_projections`.
3. Alertas ON/OFF por usuario + dispatcher.
4. Hardening: metricas, retries, backoff, pruebas e2e.

## 10) Criterios de aceptacion

- El sistema identifica consistentemente el proximo evento UFC.
- Se registran novedades deduplicadas y con impacto clasificado.
- El usuario puede ver proyecciones y ultimas novedades por boton.
- El usuario puede activar/desactivar alertas desde Config.
- No hay side effects sobre ledger/apuestas en vivo en esta fase.

## 11) Decisiones abiertas

- Fuente primaria/secundaria final para calendario y noticias.
- Umbrales finales:
  - `impact_score` para alertar,
  - delta de confianza para alerta de cambio.
- Cadencia exacta en produccion (base vs ventanas cercanas al evento).
