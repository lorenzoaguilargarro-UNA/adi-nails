// Función de Vercel que envía a la administradora un correo recordatorio
// el día antes de cada cita CONFIRMADA. La ejecuta Vercel Cron todos los días
// (ver vercel.json). Las claves viven en variables de entorno de Vercel,
// nunca en la página.
//
// Variables de entorno necesarias (Vercel → Settings → Environment Variables):
//   FIREBASE_SERVICE_ACCOUNT  JSON completo de la cuenta de servicio de Firebase
//   EMAILJS_PRIVATE_KEY       Clave privada de EmailJS (Account → API keys)
//   EMAILJS_TEMPLATE_ID       ID de la plantilla "Recordatorio" en EmailJS
//   ADMIN_EMAIL               Correo que recibe los recordatorios
//   CRON_SECRET               Texto secreto largo; Vercel Cron lo envía solo
// Opcionales: EMAILJS_SERVICE_ID, EMAILJS_PUBLIC_KEY (por defecto, los de la página).
//
// Uso manual (con el encabezado Authorization: Bearer <CRON_SECRET>):
//   /api/recordatorios?prueba=1                    → muestra qué se enviaría mañana, sin enviar nada
//   /api/recordatorios?prueba=1&fecha=2026-12-01   → igual, para otra fecha
//   /api/recordatorios?correoPrueba=1              → envía un correo de prueba a ADMIN_EMAIL

'use strict';

const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { procesarRecordatorios, fechaDesdeISO, fechaCR, fechaLarga } = require('./_lib/recordatorios');

const EMAILJS_URL = 'https://api.emailjs.com/api/v1.0/email/send';

function faltantes() {
  return ['FIREBASE_SERVICE_ACCOUNT', 'EMAILJS_PRIVATE_KEY', 'EMAILJS_TEMPLATE_ID', 'ADMIN_EMAIL', 'CRON_SECRET']
    .filter((k) => !process.env[k]);
}

function baseDeDatos() {
  if (!getApps().length) {
    const cuenta = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (cuenta.private_key) cuenta.private_key = cuenta.private_key.replace(/\\n/g, '\n');
    initializeApp({ credential: cert(cuenta) });
  }
  return getFirestore();
}

async function enviarCorreo(parametros) {
  const res = await fetch(EMAILJS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: process.env.EMAILJS_SERVICE_ID || 'service_c8zbj2c',
      template_id: process.env.EMAILJS_TEMPLATE_ID,
      user_id: process.env.EMAILJS_PUBLIC_KEY || 'F0bOc_DHO_QVwe3lN',
      accessToken: process.env.EMAILJS_PRIVATE_KEY,
      template_params: parametros
    })
  });
  if (!res.ok) throw new Error('EmailJS respondió ' + res.status + ': ' + (await res.text()).slice(0, 200));
}

function repositorio(db) {
  const citas = db.collection('citas');
  return {
    async citasDeFecha(clave) {
      const snap = await citas.where('dateKey', '==', clave).get();
      return snap.docs.map((d) => ({ id: d.id, data: d.data() }));
    },
    async reservar(id) {
      return db.runTransaction(async (tx) => {
        const ref = citas.doc(id);
        const snap = await tx.get(ref);
        const c = snap.exists ? snap.data() : null;
        if (!c || c.status !== 'confirmada' || c.recordatorioEstado) return false;
        tx.update(ref, { recordatorioEstado: 'enviando', recordatorioIntento: FieldValue.serverTimestamp() });
        return true;
      });
    },
    async marcarEnviado(id, fechaISO) {
      await citas.doc(id).update({ recordatorioEstado: 'enviado', recordatorioEnviado: fechaISO, recordatorioError: FieldValue.delete() });
    },
    async marcarError(id, mensaje) {
      // Se quita el estado para que se pueda reintentar (por ejemplo, ejecutando la función a mano).
      await citas.doc(id).update({ recordatorioEstado: FieldValue.delete(), recordatorioError: mensaje });
    }
  };
}

module.exports = async function handler(req, res) {
  const falta = faltantes();
  if (falta.includes('CRON_SECRET')) {
    return res.status(500).json({ ok: false, error: 'Falta configurar CRON_SECRET en Vercel.' });
  }
  if ((req.headers.authorization || '') !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'No autorizado' });
  }
  if (falta.length) {
    return res.status(500).json({ ok: false, error: 'Faltan variables de entorno en Vercel: ' + falta.join(', ') });
  }

  const q = req.query || {};
  try {
    if (q.correoPrueba === '1') {
      const manana = fechaCR(new Date(), 1);
      await enviarCorreo({
        to_email: process.env.ADMIN_EMAIL,
        nombre: 'Clienta de prueba', telefono: '8888-0000', whatsapp: '',
        servicio: 'Servicio de prueba', fecha: fechaLarga(manana), hora: '3:00 p. m. – 4:00 p. m.',
        notas: 'Este es un correo de PRUEBA. Si lo recibes, los recordatorios están bien configurados.'
      });
      return res.status(200).json({ ok: true, mensaje: 'Correo de prueba enviado a la administradora.' });
    }

    const prueba = q.prueba === '1';
    let fecha;
    if (q.fecha) {
      if (!prueba) return res.status(400).json({ ok: false, error: 'El parámetro fecha solo se permite junto con prueba=1.' });
      fecha = fechaDesdeISO(q.fecha);
      if (!fecha) return res.status(400).json({ ok: false, error: 'Fecha inválida. Usa AAAA-MM-DD.' });
    }

    const resumen = await procesarRecordatorios({
      repo: repositorio(baseDeDatos()),
      enviarCorreo,
      adminEmail: process.env.ADMIN_EMAIL,
      prueba,
      fecha
    });
    console.log('Recordatorios:', JSON.stringify(resumen));
    return res.status(resumen.errores.length ? 500 : 200).json({ ok: !resumen.errores.length, ...resumen });
  } catch (e) {
    console.error('Error en recordatorios:', e);
    return res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
