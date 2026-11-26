// Lógica de los recordatorios de citas (sin dependencias externas, para poder probarla).
// La usa api/recordatorios.js. Vercel no publica como función los archivos dentro de "_lib".

'use strict';

// Costa Rica no usa horario de verano: siempre UTC-6.
const OFFSET_CR_MS = -6 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

// Fecha en Costa Rica, desplazada "dias" días. Devuelve año, mes (0-11), día y día de la semana.
function fechaCR(ahora, dias) {
  const t = new Date(ahora.getTime() + OFFSET_CR_MS + (dias || 0) * DIA_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), dow: t.getUTCDay() };
}

// Misma clave que usa la página para las citas: "AAAA-M-D" con el mes empezando en 0.
function claveFecha(f) {
  return f.y + '-' + f.m + '-' + f.d;
}

// Convierte "AAAA-MM-DD" (mes 1-12) a la estructura de fecha. Devuelve null si no es válida.
function fechaDesdeISO(texto) {
  const r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto || '');
  if (!r) return null;
  const y = Number(r[1]), m = Number(r[2]) - 1, d = Number(r[3]);
  const t = new Date(Date.UTC(y, m, d));
  if (t.getUTCMonth() !== m || t.getUTCDate() !== d) return null;
  return { y, m, d, dow: t.getUTCDay() };
}

function fechaLarga(f) {
  const dia = DIAS[f.dow];
  return dia.charAt(0).toUpperCase() + dia.slice(1) + ' ' + f.d + ' de ' + MESES[f.m] + ' de ' + f.y;
}

// "15:00" -> "3:00 p. m."
function hora12(hhmm) {
  const r = /^(\d{1,2}):(\d{2})$/.exec((hhmm || '').trim());
  if (!r) return (hhmm || '').trim();
  const h = Number(r[1]);
  const sufijo = h < 12 ? 'a. m.' : 'p. m.';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ':' + r[2] + ' ' + sufijo;
}

// "15:00 – 17:00" -> "3:00 p. m. – 5:00 p. m."
function rangoHora(texto) {
  return String(texto || '').split(/\s*[–-]\s*/).map(hora12).join(' – ');
}

function horaInicioMin(cita) {
  const r = /^(\d{1,2}):(\d{2})/.exec(String((cita && cita.time) || (cita && cita.slots && cita.slots[0]) || ''));
  return r ? Number(r[1]) * 60 + Number(r[2]) : 9999;
}

// Datos que se envían a la plantilla de EmailJS.
function parametrosCorreo(cita, fecha, adminEmail) {
  const digitos = String(cita.phone || '').replace(/\D/g, '').replace(/^506/, '');
  return {
    to_email: adminEmail,
    nombre: cita.name || 'Clienta',
    telefono: cita.phone || '',
    whatsapp: digitos ? 'https://wa.me/506' + digitos : '',
    servicio: cita.service || '',
    fecha: fechaLarga(fecha),
    hora: rangoHora(cita.time),
    notas: 'Recordatorio automático: tienes esta cita confirmada mañana.'
  };
}

// Decide si una cita debe recibir recordatorio. Se usa al buscar y otra vez
// justo antes de enviar (dentro de una transacción), por si cambió en el medio.
function necesitaRecordatorio(cita) {
  return !!cita && cita.status === 'confirmada' && !cita.recordatorioEstado;
}

/**
 * Envía los recordatorios de las citas confirmadas de mañana (hora de Costa Rica).
 *
 * repo: {
 *   citasDeFecha(clave) -> [{ id, data }]
 *   reservar(id)        -> true si la cita sigue confirmada, sin recordatorio, y queda marcada "enviando"
 *   marcarEnviado(id, fechaISO)
 *   marcarError(id, mensaje)
 * }
 * enviarCorreo(parametros) -> lanza error si falla
 */
async function procesarRecordatorios(opciones) {
  const { repo, enviarCorreo, adminEmail } = opciones;
  const ahora = opciones.ahora || new Date();
  const prueba = !!opciones.prueba;
  const fecha = opciones.fecha || fechaCR(ahora, 1);
  const clave = claveFecha(fecha);

  const resumen = { fecha: fechaLarga(fecha), clave, prueba, enviados: [], omitidos: [], errores: [] };

  const citas = (await repo.citasDeFecha(clave)).slice().sort((a, b) => horaInicioMin(a.data) - horaInicioMin(b.data));

  for (const { id, data } of citas) {
    const etiqueta = (data.name || 'Clienta') + ' · ' + (data.time || '');
    if (data.status !== 'confirmada') { resumen.omitidos.push({ id, cita: etiqueta, motivo: 'estado: ' + (data.status || 'sin estado') }); continue; }
    if (data.recordatorioEstado) { resumen.omitidos.push({ id, cita: etiqueta, motivo: 'recordatorio ya ' + data.recordatorioEstado }); continue; }

    if (prueba) { resumen.enviados.push({ id, cita: etiqueta, prueba: true }); continue; }

    // Reserva atómica: vuelve a leer la cita y la marca, para no enviar dos veces
    // ni enviar si la cancelaron un instante antes.
    const reservada = await repo.reservar(id);
    if (!reservada) { resumen.omitidos.push({ id, cita: etiqueta, motivo: 'cambió antes de enviar' }); continue; }

    try {
      await enviarCorreo(parametrosCorreo(data, fecha, adminEmail));
      await repo.marcarEnviado(id, ahora.toISOString());
      resumen.enviados.push({ id, cita: etiqueta });
    } catch (e) {
      const mensaje = String((e && e.message) || e).slice(0, 300);
      await repo.marcarError(id, mensaje);
      resumen.errores.push({ id, cita: etiqueta, error: mensaje });
    }
  }
  return resumen;
}

module.exports = {
  fechaCR, claveFecha, fechaDesdeISO, fechaLarga, hora12, rangoHora,
  parametrosCorreo, necesitaRecordatorio, procesarRecordatorios
};
