import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const CODES = (process.env.PILOT_CODES || '').split(',').map(x=>x.trim()).filter(Boolean);
const DAILY_LIMIT = Math.min(200, Math.max(1, Number(process.env.DAILY_LIMIT || 50)));
const IMAGE_DAILY_LIMIT = Math.min(30, Math.max(1, Number(process.env.IMAGE_DAILY_LIMIT || 10)));
const usage = new Map();
const imageUsage = new Map();
const active = new Set();
if (HOST === '0.0.0.0' && !CODES.length) {
  console.error('SEGURIDAD: configura PILOT_CODES antes de publicar 3RV1.');
  process.exit(1);
}
function codeValid(code) {
  if (!CODES.length) return true;
  const raw = Buffer.from(code);
  return CODES.some(c=> {const candidate=Buffer.from(c);return candidate.length===raw.length && timingSafeEqual(candidate,raw);});
}
function checkQuota(code) {
  if (!CODES.length) return;
  const date = new Date().toISOString().slice(0,10);
  const key = date + ':' + code;
  const u = usage.get(key) || {count:0,times:[]};
  const now = Date.now();u.times=u.times.filter(x=>x>now-60000);
  if (u.count>=DAILY_LIMIT || u.times.length>=15) { const e=new Error('Límite de uso alcanzado. Intenta más tarde o consulta a tu profesor.');e.status=429;throw e; }
  u.count++;u.times.push(now);usage.set(key,u);
  if(usage.size>2000){for(const k of usage.keys())if(!k.startsWith(date+':'))usage.delete(k);}
}

function checkImageQuota(code) {
  if (!CODES.length) return;
  const date = new Date().toISOString().slice(0,10);
  const key = 'img:' + date + ':' + code;
  const u = imageUsage.get(key) || {count:0,times:[]};
  const now = Date.now(); u.times = u.times.filter(x=>x>now-60000);
  if (u.count >= IMAGE_DAILY_LIMIT || u.times.length >= 3) {
    const e = new Error('Límite de imágenes alcanzado. Intenta más tarde o consulta a tu profesor.');
    e.status = 429; throw e;
  }
  u.count++; u.times.push(now); imageUsage.set(key,u);
  if(imageUsage.size>2000){for(const k of imageUsage.keys())if(!k.startsWith('img:'+date+':'))imageUsage.delete(k);}
}

function buildImagePrompt(topic, subject='') {
  const area = subject || findSubject(topic) || 'Ciencias';
  const areaHints = {
    'Matemáticas': 'Si hay gráficas, muestra ejes cartesianos claros, etiquetas legibles, números visibles y relaciones matemáticas correctas. Si hay ecuaciones, escríbelas con notación matemática clara.',
    'Física': 'Incluye flechas, magnitudes, nombres de variables y la situación física de forma clara.',
    'Química': 'Incluye partículas, enlaces, símbolos o partes señaladas, con estructura clara y escolar.',
    'Biología': 'Incluye estructuras, organelos o partes etiquetadas con nombres visibles y diseño didáctico.'
  };
  return `Crea una imagen educativa clara, didáctica y en español para estudiantes de secundaria o bachillerato sobre: ${topic}. Usa fondo claro, colores suaves, etiquetas legibles, composición ordenada y contenido científicamente correcto. ${areaHints[area] || 'Presenta el concepto con claridad y valor didáctico.'} No agregues marcas de agua.`;
}

function buildImageMeta(topic, subject='') {
  const area = subject || findSubject(topic) || 'Ciencias';
  const explainByArea = {
    'Matemáticas': 'Observa las partes señaladas, la relación entre las cantidades y, si aparece una gráfica, fíjate en sus ejes, cortes o forma general.',
    'Física': 'Observa qué magnitudes intervienen, la dirección de las flechas y cómo cambia el sistema o la energía.',
    'Química': 'Observa las partículas, enlaces, símbolos o partes señaladas y cómo se relacionan entre sí.',
    'Biología': 'Observa las estructuras, sus nombres y la función principal de cada parte.'
  };
  const title = 'Imagen educativa: ' + topic.slice(0,80);
  return {
    title,
    explanation: `Aquí tienes una imagen educativa sobre ${topic}. ${explainByArea[area] || 'Observa con atención las partes señaladas y sus relaciones.'} Si quieres, puedo explicarte cada parte paso a paso.`,
    question: `Explícame paso a paso la imagen sobre ${topic}.`
  };
}

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const sessions = new Map();
const MAX_HISTORY = 16;

function getSession(id, code) {
  if (id && sessions.has(id) && sessions.get(id).accessCode === code) return sessions.get(id);
  const session = {
    id: randomUUID(), accessCode: code, phase: 'greeting', name: '', subject: '',
    turns: [], stage: 0, mastered: [], mistakes: 0
  };
  sessions.set(session.id, session);
  return session;
}
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
function responseFor(session, reply) {
  return { sessionId: session.id, reply, stage: session.stage, total: 3, completed: false };
}
function extractText(data) {
  return (data.output || []).flatMap(item => item.content || [])
    .filter(item => item.type === 'output_text').map(item => item.text).join('\n').trim();
}
function findSubject(message) {
  if (/matem[aá]tica|[aá]lgebra|fracci[oó]n|ecuaci[oó]n|geometr[ií]a/i.test(message)) return 'Matemáticas';
  if (/f[ií]sica|movimiento|fuerza|energ[ií]a|velocidad/i.test(message)) return 'Física';
  if (/qu[ií]mica|[aá]tomo|mol[eé]cula|elemento|reacci[oó]n/i.test(message)) return 'Química';
  if (/biolog[ií]a|c[eé]lula|gen[eé]tica|ecosistema|organismo|fotos[ií]ntesis/i.test(message)) return 'Biología';
  return '';
}
function normalizeName(message) {
  const value = message.trim().replace(/^(me llamo|mi nombre es|soy)\s+/i, '');
  const match = value.match(/^([\p{L}]{2,25})(?:\s|$)/u);
  return match ? match[1] : '';
}
async function tutorReply(session, student) {
  const instructions = `Eres 3RV1, tutor virtual de Matemáticas, Física, Química y Biología para adolescentes y adultos. Hablas en español mexicano, con tono amable, natural y respetuoso. Eres una IA, no una persona. El estudiante se llama ${session.name} y eligió ${session.subject}. No repitas su nombre en cada respuesta.\n\nREGLAS PEDAGÓGICAS: habla normalmente en una o dos frases (idealmente 15 a 40 palabras, máximo 55). Solo una pregunta a la vez, luego espera. Primero averigua qué tema o duda tiene el estudiante y su nivel, sin dar conferencias. Da una pista o un paso pequeño; no resuelvas todo de inmediato. Ajusta el nivel según la respuesta y ofrece ejemplos cotidianos solo si hacen falta. Si se equivoca, corrige con paciencia, sin elogios exagerados. Si pide una explicación completa, puedes darla brevemente y por etapas. Cuando quiera terminar, despídete en una frase. Puedes cambiar de materia cuando el estudiante lo pida. No hagas preguntas personales ni pidas datos sensibles. No afirmes que las calificaciones son oficiales.\n\nDevuelve EXCLUSIVAMENTE JSON con estas claves: reply (texto natural para decir en voz alta) y mastered (boolean). Usa mastered=true solamente cuando haya evidencia de que resolvió y explicó correctamente un ejercicio, no por adivinar o repetir una respuesta. No menciones el JSON.`;
  const input = [...session.turns.slice(-MAX_HISTORY), { role: 'user', content: student }];
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, store: false, instructions, input,
        text: { format: { type: 'json_schema', name: 'tutor_turn', strict: true,
          schema: { type: 'object', additionalProperties: false,
            properties: { reply: { type: 'string' }, mastered: { type: 'boolean' } },
            required: ['reply', 'mastered'] } } },
        max_output_tokens: 200
      })
    });
  } catch {
    throw new Error('No se pudo conectar con OpenAI. Revisa tu conexión a internet.');
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Error API ${response.status}`);
  const parsed = JSON.parse(extractText(payload));
  session.turns.push({ role: 'user', content: student }, { role: 'assistant', content: parsed.reply });
  if (session.turns.length > MAX_HISTORY) session.turns = session.turns.slice(-MAX_HISTORY);
  return responseFor(session, parsed.reply);
}

async function handleMessage(session, message) {
  if (session.phase === 'greeting') {
    session.phase = 'name';
    return responseFor(session, '¡Hola! Soy 3RV1, tu tutor virtual de Matemáticas, Física, Química y Biología. ¡Qué gusto saludarte! ¿Cómo te llamas?');
  }
  if (session.phase === 'name') {
    const name = normalizeName(message);
    if (!name) return responseFor(session, '¿Me dices cómo prefieres que te llame? Solo tu nombre está bien.');
    session.name = name;
    session.phase = 'subject';
    return responseFor(session, `¡Mucho gusto, ${name}! ¿Hoy quieres estudiar Matemáticas, Física, Química o Biología?`);
  }
  if (session.phase === 'subject') {
    const subject = findSubject(message);
    if (!subject) return responseFor(session, 'Perfecto. ¿Elegimos Matemáticas, Física, Química o Biología?');
    session.subject = subject;
    session.phase = 'tutoring';
    return responseFor(session, `¡Muy bien! Vamos con ${subject}. ¿Qué tema te gustaría aprender o repasar?`);
  }
  const subject = findSubject(message);
  if (subject && subject !== session.subject) {
    session.subject = subject;
    session.turns = [];
    return responseFor(session, `Claro, cambiamos a ${subject}. ¿Qué tema quieres revisar?`);
  }
  return await tutorReply(session, message);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(await readFile(new URL('./index.html', import.meta.url)));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/imagenes/')) {
      const archivo = decodeURIComponent(url.pathname.slice('/imagenes/'.length));
      const permitidos = ['fracciones.webp','parabola.webp','energia.webp','atomo.webp','celula.webp'];
      if (!permitidos.includes(archivo)) return send(res,404,{error:'Imagen no encontrada'});
      const contenido = await readFile(new URL('./imagenes/' + archivo, import.meta.url));
      res.writeHead(200, { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=3600' });
      res.end(contenido);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/access') {
      let raw=''; for await (const part of req){raw+=part;if(raw.length>2000)return send(res,413,{error:'Solicitud demasiado larga'});}
      const body=JSON.parse(raw);
      return codeValid(String(body.code||'')) ? send(res,200,{ok:true}) : send(res,403,{error:'Código incorrecto. Solicita uno a tu profesor.'});
    }
    if (req.method === 'POST' && url.pathname === '/image') {
      let raw = '';
      for await (const part of req) {
        raw += part;
        if (raw.length > 4000) return send(res, 413, { error: 'Solicitud demasiado larga' });
      }
      const body = JSON.parse(raw || '{}');
      const topic = String(body.prompt || '').trim();
      if (!topic || topic.length > 220) return send(res, 400, { error: 'Escribe un tema o descripción de hasta 220 caracteres.' });
      if (!KEY) return send(res, 503, { error: 'La clave API no está configurada en el servidor.' });
      const code = String(req.headers['x-pilot-code'] || '').trim();
      if (!codeValid(code)) return send(res, 403, { error: 'Código incorrecto. Solicita uno a tu profesor.' });
      checkImageQuota(code);
      const session = getSession(body.sessionId, code);
      const subject = session.subject || findSubject(topic) || '';
      const prompt = buildImagePrompt(topic, subject);
      let response;
      try {
        response = await fetch('https://api.openai.com/v1/images/generations', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-image-1', prompt, size: '1024x1024' })
        });
      } catch {
        throw new Error('No se pudo conectar con OpenAI para generar la imagen.');
      }
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || `Error API ${response.status}`);
      const b64 = payload.data?.[0]?.b64_json || payload.data?.[0]?.b64Json;
      if (!b64) throw new Error('No se recibió la imagen generada.');
      const meta = buildImageMeta(topic, subject);
      return send(res, 200, {
        imageUrl: `data:image/png;base64,${b64}`,
        alt: meta.title,
        ...meta
      });
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      let raw = '';
      for await (const part of req) {
        raw += part;
        if (raw.length > 12000) return send(res, 413, { error: 'Mensaje demasiado largo' });
      }
      const body = JSON.parse(raw);
      const message = String(body.message || '').trim();
      if (!message || message.length > 1500) return send(res, 400, { error: 'Escribe un mensaje de hasta 1500 caracteres.' });
      if (!KEY) return send(res, 503, { error: 'La clave API no está configurada en el servidor.' });
      const code=String(req.headers['x-pilot-code']||'').trim();
      if (!codeValid(code)) return send(res,403,{error:'Código incorrecto. Solicita uno a tu profesor.'});
      if (active.has(code)) return send(res,429,{error:'Espera a que termine tu respuesta anterior.'});
      checkQuota(code);
      active.add(code);
      try {
        const session = getSession(body.sessionId, code);
        return send(res, 200, await handleMessage(session, message));
      } finally {active.delete(code);}
    }
    send(res, 404, { error: 'Ruta inexistente' });
  } catch (err) {
    console.error(err);
    send(res, err.status || 500, { error: (err.status ? err.message : 'No se pudo completar la solicitud. Revisa la conexión y el servidor.') });
  }
});
server.listen(PORT, HOST, () => console.log(`3RV1 disponible en ${HOST}:${PORT}`));
