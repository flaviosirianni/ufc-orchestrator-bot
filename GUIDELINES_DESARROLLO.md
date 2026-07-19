# Guidelines de Desarrollo (Calidad por Defecto)

1. Documentar cada clase, metodo y funcion con:
- Por que existe
- @returns
- Efectos secundarios
- Errores esperados (cuando aplique)

2. Mantener tracker de calidad actualizado:
- docs/CODE_QUALITY_TRACKER.tsv
- docs/CODE_QUALITY_TRACKER_SUMMARY.md
- docs/CODE_QUALITY_TEST_GAPS.md

3. Ningun cambio semantico de codigo se considera cerrado sin evidencia:
- tests automatizados (web y funciones puras criticas)
- o runtime QA formal (legacy side-effects)
