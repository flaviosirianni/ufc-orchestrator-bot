# UFC Operational Baseline v1

El baseline canónico usa `ufc-operational-snapshot/v1` y se genera con:

```bash
npm run ufc:baseline:capture -- \
  --db /path/to/bot.db \
  --stats-db /path/to/ufc_stats.db \
  --service bot-factory@ufc \
  --health-url http://127.0.0.1:3000/health \
  --git-sha <deployed-sha> \
  --out /path/to/snapshot.json
```

## Garantías de privacidad e integridad

- Las SQLite se abren con `readonly` y `query_only`; el test compara SHA-256 antes/después y exige igualdad byte-for-byte.
- No se persiste ninguna fila, chat, mensaje, usuario, ticket ni payload.
- Health se sanitiza recursivamente y redacta tokens, claves y campos identificables.
- Journal se reduce a conteos por categoría, rango temporal y digest de la secuencia; nunca conserva líneas crudas.
- El digest de cada tabla protegida se calcula sobre valores tipados, hasheados por fila y ordenados, por lo que no depende del orden físico.
- El archivo UFC se hashea por chunks. Para `ufc_stats.db` v1 evita dos lecturas completas costosas: omite hash de archivo y `quick_check`, pero conserva metadata, schema hash, conteos exactos y su digest. UFC-STAB-201/203 validará `quick_check` sobre el candidato y UFC-STAB-501 incorporará SHA-256 del backup.

## Tablas protegidas v1

- `bets`
- `bet_mutations`
- `ledger_summary`
- `user_credits`
- `credit_transactions`
- `mp_processed_payments`

La ausencia de cualquiera se registra en `missing_protected_tables`; nunca se crea automáticamente.

## Señales runtime permitidas

- Systemd: ID, active/sub state, PID principal, restarts, inicio, working directory, unit y cgroup.
- Paths: existencia, tipo, tamaño y mtime.
- Health: status HTTP y payload sanitizado.
- Journal: categorías de 409, background refresh, candidatos deportivos sospechosos, restarts, billing, Odds 401 y otros errores.

## Comparación

Dos snapshots se comparan por:

1. `schema_version` y SHA deployado.
2. `quick_check`, `schema_sha256`, `table_counts_sha256` y conteos por tabla.
3. Conteo y `content_sha256` de cada tabla protegida.
4. Paths y estado systemd/health.
5. Deltas de categorías journal.

Un cambio de digest protegido bloquea cualquier migración, limpieza o settlement hasta ser explicado y autorizado por el flujo correspondiente.
