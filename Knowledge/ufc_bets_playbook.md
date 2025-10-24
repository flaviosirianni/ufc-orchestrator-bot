# UFC BETS Knowledge — v2025-10-24

## Cambios desde v2025-10-18
- Agregadas lecciones del evento 2025-10-18.
- Umbral por defecto: ML/Totals EV ≥ +2%; Props EV ≥ +3–4%.
- Plantilla de salida y esquema de ledger (CSV) unificados.

## Reglas de valor (EV)
- ML / Totals (Over/Under): EV ≥ **+2%**
- Props (método, ITD, builders): EV ≥ **+3–4%**
- EV (decimal): `EV = p_estimada × (cuota − 1) − (1 − p_estimada)`
- Prob. implícita de una cuota: `1 / cuota`

## Heurísticas por tipo de pelea
- **Pick’em (ML parejo)** → Priorizar **Over 1.5** si ambos son duros y no ultra-agresivos temprano.
- **Favorita clara** vs rival muy resistente → **Decisión**.
- **Favorita top** con gran gap atlético/técnico → **KO/TKO** antes que Decisión.
- **Grappler A+** vs defensa dudosa → **Sumisión** o **ITD** si el precio da.
- **Riesgo de arranque explosivo** (KDs o guillotinas tempranas) → Evitar **Over 2.5** salvo cuota muy alta.

## Checklist del día de evento
1) Capturas de Bet365 (ML, O/U principal, Método KO/SUB/DEC, ITD si hay).
2) Pesaje/Noticias: miss de peso, short notice, cambios de rival, entrevistas (foco en boxeo/grappling), lesiones.
3) Estilos: alcance/postura, TD/TDD, control, absorción, volumen, forma (últimos 5), cambio de división.
4) Estimar p(A)/p(B) con criterio conservador. Calcular EV de ML y **2–4 props con sentido**.
5) Recomendación solo si supera umbral EV. Fijar **cuota mínima aceptable**; si baja, no entrar.
6) Staking base: **1 u = 1% del bank del evento**. Topes sugeridos: ≤2 u por pelea; ≤8 u por evento.
7) Evitar “duplicar narrativa” (ej. SUB + ITD del mismo lado) salvo que el precio lo justifique.

## Plantilla de salida (por pelea)
**[División] • [Fighter A] vs [Fighter B]**  
**Cuotas Bet365 (hora AR):** A @x.xx | B @x.xx | [props clave]  
**Mi lectura:** [2–3 líneas: estilos, cardio, durabilidad, riesgo early]  
**Prob. estimada:** A xx% | B xx%  
**EV (valor esperado):** [breve nota: si es positivo conviene]  

**Recomendación**  
- Mercado: [ML / Over/Under / Método / ITD / Parlay 2–3 legs]  
- Selección: [ej. A por Decisión]  
- Cuota actual: @x.xx | **Tomar solo si ≥ @x.xx**  
- Stake: x.x u (≈ $x.xxx)  
**Confianza:** [Alta/Media/Baja]  
**Motivos:** • … • … • …  
**Riesgos:** • … • …  
**Notas últimas horas:** [miss de peso / lesión / reemplazo]

## Ledger (CSV) — esquema fijo
Archivo: `ufc_event_[YYYY-MM-DD]_ledger.csv`  
Columnas:  
`event_date,event_name,fight,market,selection,odds_decimal,stake_units,stake_ARS,status,result,profit_units,profit_ARS`  
Reglas: al confirmar → `PENDING`; al finalizar → `WON/LOST` + `profit_*`; recalcular **Total**, **P&L** y **ROI** tras cada pelea.

## Lecciones del evento 2025-10-18 (ejemplos)
- **Jourdain vs Grant — SUB R1:** Evitar Overs largos; priorizar **ITD/SUB** si el precio lo permite.  
- **Fiorot vs Jasudavicius — TKO 1:14:** En rebote contra rival inferior atlético, subir prob. de **TKO**; mejor **ML/TKO** que “Decisión”.  
- **Holland vs Malott — UD:** En pick’ems, **Over 1.5** suele ser más estable que ML.  
- **Nelson vs Frevola — UD:** Si el local controla y el otro depende del caos, considerar **Decisión local**.  
- **de Ridder vs Allen — Allen TKO:** Si vamos fuerte a método del favorito, chequear el **poder del underdog**; reducir exposición o micro-hedge si el precio ayuda.

## Mini-glosario
- **ML (moneyline):** quién gana.  
- **Over/Under X.5:** si la pelea pasa X.5 rounds.  
- **ITD (Inside the Distance):** gana antes de tarjetas (KO/TKO/DQ o SUB).  
- **Unidad (u):** % del bank (por defecto 1%).  
- **EV (valor esperado):** si nuestra prob supera la implícita de la cuota, hay valor.