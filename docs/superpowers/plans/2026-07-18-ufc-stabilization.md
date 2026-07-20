# UFC Betting Bot Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. No subagents are used for this repo unless the user explicitly requests delegation. Steps use checkbox syntax for tracking.

**Goal:** Estabilizar veracidad deportiva, billing, runtime y persistencia UFC sin alterar el ledger.

**Architecture:** Un truth gate desacopla fuentes de consumidores y aplica fail-closed. Los artefactos deportivos y las migraciones usan candidate/verify/atomic-swap/rollback. Billing y Telegram exponen estado operativo explícito y nunca recuperan mediante mutaciones silenciosas.

**Tech Stack:** Node.js ESM, `better-sqlite3`, Telegram polling, systemd, Bash, Python/Playwright en `data_scrapper`, OCI.

---

## Protocolo por tarea

- [ ] Cambiar el ítem correspondiente de `BACKLOG.md` a `IN_PROGRESS`.
- [ ] Escribir primero el test de incidente o contrato y verificar RED.
- [ ] Implementar el cambio mínimo y verificar GREEN.
- [ ] Ejecutar matriz de regresión según riesgo y ledger suite si se toca el store/settlement.
- [ ] Actualizar quality tracker, backlog y handoff.
- [ ] Commitear sólo archivos del alcance y registrar SHA.
- [ ] Para runtime: correr gates, desplegar, verificar health/logs y documentar rollback.

## Task 0 — Control y baseline

**Files:** `docs/ufc-stabilization/*`, `docs/superpowers/*`, quality pack, parity UFC, `__tests__/runTests.js`, `__tests__/toolsHandlers.test.js`.

- [x] Crear worktree `stabilize/ufc-runtime-integrity` desde `main` limpio.
- [x] Instalar dependencias y correr suite baseline.
- [x] Crear backlog/spec/plan/handoff y enlaces históricos.
- [x] Aplicar y completar quality pack.
- [x] Agregar gate UFC prod-like con tests.
- [x] Reproducir el error de refresh en RED y endurecer el runner/cleanup hasta GREEN limpio.
- [x] Capturar snapshot operativo anonimizado antes de runtime.
- [x] Fusionar, desplegar y verificar Etapa 0 con health, proceso único y digest protegido pre/post.

## Task 1 — Contención

**Files:** módulos nuevos de truth gate, `eventIntel`, `preFightAnalysis`, `eventMirrorService`, `autoSettlement`, `sqliteStore`, health y tests asociados.

- [x] Persistir confianza/evidencia y log append-only sin cambiar ledger.
- [ ] Aplicar fail-closed a todos los consumidores.
- [ ] Dedupe projection/scoring por hash.
- [ ] Extender health.
- [ ] Ejecutar backup, marcar estado corrupto y verificar digest ledger.
- [ ] Gate/deploy/smoke/observación 24 h.

## Task 2 — Fuentes deportivas

**Files:** proyecto hermano `data_scrapper`, `ufcStatsTool`, adaptadores de fuentes, reconciliador, Odds API monitor, systemd stats sync.

- [ ] Hardening y tests de scraper/convertidor.
- [ ] Metadata y fechas ISO compatibles.
- [ ] Pipeline OCI atómico con timer y rollback.
- [ ] Reconciliador current/next con quorum.
- [ ] Reglas live conservadoras y circuito Odds.
- [ ] Reconstruir estado productivo y observar freshness.

## Task 3 — Billing

**Files:** billing client/bridge/server/store, health, CLI de reconciliación y tests.

- [ ] Introducir modo explícito y fail-closed productivo.
- [ ] Idempotencia estable y telemetría.
- [ ] Dry-run de reconciliación con backups.
- [ ] Apply sólo determinístico y verificar delta/duplicados.
- [ ] Deploy y smoke sin recarga real.

## Task 4 — Runtime

**Files:** bootstrap UFC, Telegram runtime, guard shell, units systemd, postmortem y tests.

- [ ] Supervisor y shutdown de handles.
- [ ] Singleton/telemetría de instancia.
- [ ] 409 conflict state y backoff acotado.
- [ ] Guard persistente y restart budget.
- [ ] Systemd hardening y soak siete días.

## Task 5 — Datos

**Files:** migrador/maintenance CLI, manifest/env/ops units y tests de migración/retención.

- [ ] Inventario allowlist y digests protegidos.
- [ ] Backup+restore drill.
- [ ] Cutover de paths y DB UFC-only.
- [ ] Retención por tabla con dry-run.
- [ ] Limpieza/VACUUM sobre candidato y swap.
- [ ] Job diario y observación del path viejo 14 días.

## Task 6 — Cierre

- [ ] Ejecutar matriz completa y gates de publicación.
- [ ] Smoke productivo no mutante y comparar ledger digest.
- [ ] Completar runbooks y evidencia.
- [ ] Cerrar backlog salvo ventanas `WAITING_OBSERVATION`.
- [ ] Ejecutar guard Git finish y `finishing-a-development-branch`.
