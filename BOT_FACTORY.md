# Bot Factory - Blueprint Operativo

## Decisiones de arquitectura

- Monorepo `Core + Bots`.
- Runtime: un servicio `systemd` por bot.
- Billing global compartido (wallet unica por usuario Telegram).
- Datos: DB de billing separada + DB de dominio separada por bot.
- Estrategia: UFC migrado como bot v1 y base para bots nuevos.

## Estructura

```text
src/
  platform/
    launcher.js
    manifest.js
    billing/
    policy/
    runtime/
  services/
    billing/
  bots/
    ufc/
    nutrition/
    medical_reader/
    templates/
```

## Contratos publicos

### Manifest

`src/bots/<bot_id>/bot.manifest.json`

- `bot_id`
- `display_name`
- `telegram_token_env`
- `interaction_mode`
- `domain_pack`
- `credit_policy`
- `risk_policy`
- `storage.db_path`

### Billing API interna

- `POST /billing/spend`
- `POST /billing/topup/create-checkout`
- `POST /billing/topup/webhook/mercadopago`
- `GET /billing/state?user_id=...`
- `GET /billing/transactions?user_id=...`
- `GET /billing/usage?user_id=...`

Envelope normalizado de respuesta:

- `ok`
- `error_code`
- `idempotency_status`
- `trace_id`

## Entorno estandar

### Global

- `BILLING_BASE_URL`
- `BILLING_API_TOKEN`
- `APP_PUBLIC_URL`
- `MP_*`

### Por bot

- `BOT_ID`
- `TELEGRAM_BOT_TOKEN` (o `<BOT>_TELEGRAM_BOT_TOKEN` via manifest)
- `DB_PATH`
- `INTERACTION_MODE`
- `BOT_POLICY_PACK`

## Policy packs transversales

- `general_safe_advice`
- `medical_non_diagnostic`
- `nutrition_guidance_non_clinical`

Aplicacion runtime: `enforcePolicyPack` en respuesta final.

## Scaffold de nuevos bots

Comando:

```bash
npm run scaffold:bot -- --id <bot_id> --template <expert_advisor|document_reader>
```

Genera:

- `src/bots/<bot_id>/bot.manifest.json`
- `src/bots/<bot_id>/index.js`
- `src/bots/<bot_id>/prompt.md`
- `.env.<bot_id>.example`

## Operacion OCI

- Billing: `billing-service.service`.
- Bots: `bot-factory@<bot_id>.service`.
- Env files en `/etc/bot-factory/`.
- Data en `/home/ubuntu/bot-data/`.

Referencias:

- `ops/systemd/*`
- `ops/nginx/*`
- `ops/README.md`
