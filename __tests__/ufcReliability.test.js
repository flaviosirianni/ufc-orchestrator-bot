import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneOldBackups } from '../src/bots/ufc/ufcReliability.js';

function seedBackup(dir, name, ageDays) {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, 'x');
  const mtime = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, mtime, mtime);
  return filePath;
}

export async function runUfcReliabilityTests() {
  {
    // Retención escalonada (grandfather-father-son): todo dentro de la ventana
    // reciente se conserva completo (para rollback rapido de deploys), y de lo
    // mas viejo que eso solo se guarda un snapshot por cada hito, el mas
    // cercano a esa antiguedad objetivo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-reliability-'));
    try {
      seedBackup(dir, 'ufc-backup-recent-1.sqlite', 1);
      seedBackup(dir, 'ufc-backup-recent-2.sqlite', 3);
      const milestone15 = seedBackup(dir, 'ufc-backup-milestone-15.sqlite', 14.8);
      seedBackup(dir, 'ufc-backup-noise-13.sqlite', 13);
      seedBackup(dir, 'ufc-backup-noise-20.sqlite', 20);
      const milestone30 = seedBackup(dir, 'ufc-backup-milestone-30.sqlite', 30.2);
      seedBackup(dir, 'ufc-backup-noise-45.sqlite', 45);

      // Ojo: "el mas cercano disponible" no exige tolerancia — si no hay nada
      // cerca de 60/90d, el archivo mas cercano disponible (aunque este lejos)
      // se queda, para no dejar el hito sin cobertura mientras el historial
      // real todavia no llego a esa profundidad. Ese caso se prueba aparte:
      // acá probamos solo 15/30, que sí tienen candidatos cercanos reales.
      const pruned = pruneOldBackups(dir, { recentDays: 5, milestoneDays: [15, 30] });

      const survivors = fs.readdirSync(dir).sort();
      assert.deepEqual(survivors, [
        'ufc-backup-milestone-15.sqlite',
        'ufc-backup-milestone-30.sqlite',
        'ufc-backup-recent-1.sqlite',
        'ufc-backup-recent-2.sqlite',
      ]);
      assert.equal(pruned.length, 3);
      assert.ok(fs.existsSync(milestone15));
      assert.ok(fs.existsSync(milestone30));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    // Cuando ningun backup esta realmente cerca de un hito lejano (60/90d),
    // el mas cercano disponible lo cubre igual (sin tolerancia de distancia)
    // — evita dejar el hito sin cobertura mientras el historial real todavia
    // no llego a esa profundidad; se autocorrige solo con el tiempo.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-reliability-'));
    try {
      seedBackup(dir, 'ufc-backup-recent-1.sqlite', 1);
      const onlyOlder = seedBackup(dir, 'ufc-backup-only-older.sqlite', 20);

      const pruned = pruneOldBackups(dir, { recentDays: 5, milestoneDays: [30, 60, 90] });

      assert.deepEqual(fs.readdirSync(dir).sort(), [
        'ufc-backup-only-older.sqlite',
        'ufc-backup-recent-1.sqlite',
      ]);
      assert.equal(pruned.length, 0);
      assert.ok(fs.existsSync(onlyOlder));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    // Sin backups mas viejos que la ventana reciente, un hito sin candidato
    // simplemente no aporta ningun archivo (no revienta, no inventa nada).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-reliability-'));
    try {
      seedBackup(dir, 'ufc-backup-recent-1.sqlite', 1);

      const pruned = pruneOldBackups(dir, { recentDays: 5, milestoneDays: [15, 30, 60, 90] });

      assert.deepEqual(fs.readdirSync(dir), ['ufc-backup-recent-1.sqlite']);
      assert.equal(pruned.length, 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  {
    // Archivos que no matchean el patron ufc-backup-*.sqlite (ej. sidecars
    // -shm/-wal, u otros archivos sueltos) nunca se tocan.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ufc-reliability-'));
    try {
      seedBackup(dir, 'ufc-backup-old.sqlite', 40);
      seedBackup(dir, 'ufc-backup-old.sqlite-shm', 40);
      seedBackup(dir, 'ufc-backup-old.sqlite-wal', 40);
      seedBackup(dir, 'not-a-backup.txt', 40);

      pruneOldBackups(dir, { recentDays: 5, milestoneDays: [30] });

      const survivors = fs.readdirSync(dir).sort();
      assert.deepEqual(survivors, [
        'not-a-backup.txt',
        'ufc-backup-old.sqlite',
        'ufc-backup-old.sqlite-shm',
        'ufc-backup-old.sqlite-wal',
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('All ufc reliability tests passed.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runUfcReliabilityTests().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
