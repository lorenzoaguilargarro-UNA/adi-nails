// Pruebas de la lógica de recordatorios: `npm test`
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const r = require('../api/_lib/recordatorios');

// Base de datos falsa en memoria que imita el repositorio de Firestore.
function repoFalso(citas) {
  const db = JSON.parse(JSON.stringify(citas));
  return {
    db,
    async citasDeFecha(clave) { return Object.entries(db).filter(([, c]) => c.dateKey === clave).map(([id, c]) => ({ id, data: { ...c } })); },
    async reservar(id) { const c = db[id]; if (!r.necesitaRecordatorio(c)) return false; c.recordatorioEstado = 'enviando'; return true; },
    async marcarEnviado(id, f) { db[id].recordatorioEstado = 'enviado'; db[id].recordatorioEnviado = f; },
    async marcarError(id, m) { delete db[id].recordatorioEstado; db[id].recordatorioError = m; }
  };
}

// Lunes 30 nov 2026, 7:00 a. m. en Costa Rica = 13:00 UTC (hora del cron)
const AHORA = new Date('2026-11-30T13:00:00Z');
const MANANA = '2026-11-1'; // martes 1 de diciembre de 2026 (mes empieza en 0)

const base = {
  a: { name: 'Ana', phone: '8888-1111', dateKey: MANANA, time: '15:00 – 17:00', service: 'Gel X — ₡15.000', status: 'confirmada' },
  b: { name: 'Bea', phone: '88882222', dateKey: MANANA, time: '09:00 – 10:00', service: 'Retiro', status: 'pendiente' },
  c: { name: 'Caro', phone: '88883333', dateKey: MANANA, time: '11:00 – 12:00', service: 'Retiro', status: 'cancelada' },
  d: { name: 'Dani', phone: '88884444', dateKey: '2026-11-2', time: '10:00 – 11:00', service: 'Retiro', status: 'confirmada' },
  e: { name: 'Eva', phone: '88885555', dateKey: MANANA, time: '08:00 – 09:00', service: 'Retiro', status: 'confirmada', recordatorioEstado: 'enviado' }
};

test('mañana se calcula con la hora de Costa Rica (UTC-6)', () => {
  assert.strictEqual(r.claveFecha(r.fechaCR(AHORA, 1)), MANANA);
  // 30 nov 23:30 en CR = 1 dic 05:30 UTC: en CR todavía es 30, mañana = 1 dic
  assert.strictEqual(r.claveFecha(r.fechaCR(new Date('2026-12-01T05:30:00Z'), 1)), MANANA);
  // Cambio de año
  assert.strictEqual(r.claveFecha(r.fechaCR(new Date('2026-12-31T13:00:00Z'), 1)), '2027-0-1');
});

test('solo se envía a citas confirmadas de mañana, sin duplicar', async () => {
  const repo = repoFalso(base);
  const enviados = [];
  const res = await r.procesarRecordatorios({ repo, enviarCorreo: async (p) => enviados.push(p), adminEmail: 'adi@ejemplo.com', ahora: AHORA });
  assert.deepStrictEqual(enviados.map((p) => p.nombre), ['Ana']);
  assert.strictEqual(repo.db.a.recordatorioEstado, 'enviado');
  assert.strictEqual(repo.db.b.recordatorioEstado, undefined, 'pendiente no se marca');
  assert.strictEqual(repo.db.c.recordatorioEstado, undefined, 'cancelada no se marca');
  assert.strictEqual(repo.db.d.recordatorioEstado, undefined, 'otra fecha no se toca');
  assert.strictEqual(res.omitidos.length, 3);

  // Segunda ejecución el mismo día: no repite
  const enviados2 = [];
  await r.procesarRecordatorios({ repo, enviarCorreo: async (p) => enviados2.push(p), adminEmail: 'adi@ejemplo.com', ahora: AHORA });
  assert.strictEqual(enviados2.length, 0);
});

test('contenido del correo', async () => {
  const enviados = [];
  await r.procesarRecordatorios({ repo: repoFalso(base), enviarCorreo: async (p) => enviados.push(p), adminEmail: 'adi@ejemplo.com', ahora: AHORA });
  assert.deepStrictEqual(enviados[0], {
    to_email: 'adi@ejemplo.com', nombre: 'Ana', telefono: '8888-1111', whatsapp: 'https://wa.me/50688881111',
    servicio: 'Gel X — ₡15.000', fecha: 'Martes 1 de diciembre de 2026', hora: '3:00 p. m. – 5:00 p. m.',
    notas: 'Recordatorio automático: tienes esta cita confirmada mañana.'
  });
});

test('si la cancelan justo antes de enviar, no se envía', async () => {
  const repo = repoFalso(base);
  const original = repo.citasDeFecha;
  repo.citasDeFecha = async (k) => { const l = await original(k); repo.db.a.status = 'cancelada'; return l; };
  const enviados = [];
  const res = await r.procesarRecordatorios({ repo, enviarCorreo: async (p) => enviados.push(p), adminEmail: 'x@x.com', ahora: AHORA });
  assert.strictEqual(enviados.length, 0);
  assert.ok(res.omitidos.some((o) => o.motivo === 'cambió antes de enviar'));
});

test('si el correo falla, se registra el error y se puede reintentar', async () => {
  const repo = repoFalso(base);
  const res = await r.procesarRecordatorios({ repo, enviarCorreo: async () => { throw new Error('sin cuota'); }, adminEmail: 'x@x.com', ahora: AHORA });
  assert.strictEqual(res.errores.length, 1);
  assert.strictEqual(repo.db.a.recordatorioEstado, undefined);
  assert.strictEqual(repo.db.a.recordatorioError, 'sin cuota');
  const enviados = [];
  await r.procesarRecordatorios({ repo, enviarCorreo: async (p) => enviados.push(p), adminEmail: 'x@x.com', ahora: AHORA });
  assert.strictEqual(enviados.length, 1);
});

test('modo prueba no envía ni modifica nada', async () => {
  const repo = repoFalso(base);
  let llamadas = 0;
  const res = await r.procesarRecordatorios({ repo, enviarCorreo: async () => llamadas++, adminEmail: 'x@x.com', ahora: AHORA, prueba: true });
  assert.strictEqual(llamadas, 0);
  assert.strictEqual(res.enviados.length, 1);
  assert.deepStrictEqual(repo.db, JSON.parse(JSON.stringify(base)));
});

test('fechaDesdeISO valida fechas', () => {
  assert.strictEqual(r.claveFecha(r.fechaDesdeISO('2026-12-01')), MANANA);
  assert.strictEqual(r.fechaDesdeISO('2026-02-30'), null);
  assert.strictEqual(r.fechaDesdeISO('mañana'), null);
});
