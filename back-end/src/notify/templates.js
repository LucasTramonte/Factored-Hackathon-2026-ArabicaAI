/**
 * Notification email text in Spanish, Portuguese and English. Slots: ``{reference}``, ``{status}`` (``update`` only)
 * and ``{urgent}``. Bodies never carry the customer's statement and never call a report resolved: a person reviews
 * it and no refund has been started. ``render`` returns the plain text and a branded HTML version of the same words.
 */
const FOOTER = {
  es: 'No se ha iniciado ningún reembolso.\n\n--\nArabicaAI es una demostración con datos sintéticos; no es un servicio bancario real.',
  pt: 'Nenhum reembolso foi iniciado.\n\n--\nArabicaAI é uma demonstração com dados sintéticos; não é um serviço bancário real.',
  en: 'No refund has been started.\n\n--\nArabicaAI is a demo with synthetic data; it is not a real banking service.'
};
const URGENT = {
  es: 'Si no reconoces este cargo y tu tarjeta sigue activa, llama a tu banco para bloquearla. Este servicio no bloquea tarjetas.\n\n',
  pt: 'Se você não reconhece esta cobrança e seu cartão continua ativo, ligue para o seu banco para bloqueá-lo. Este serviço não bloqueia cartões.\n\n',
  en: 'If you do not recognize this charge and your card is still active, call your bank to block it. This service does not block cards.\n\n'
};
/** The button under the body; it opens the app, where "Your reports" shows the status. */
const CTA = { es: 'Ver mis reportes', pt: 'Ver meus relatos', en: 'See my reports' };
const REFERENCE_LABEL = { es: 'Referencia', pt: 'Referência', en: 'Reference' };

/** ``TEMPLATES[lang][template]`` is ``{ subject, body }``; the footer is appended by ``render``. */
export const TEMPLATES = {
  es: {
    received: { subject: 'Recibimos tu reporte {reference}',
      body: 'Recibimos tu reporte de un cargo no reconocido. Tu referencia es {reference}.\n\nUna persona lo revisará; te avisaremos cuando cambie su estado.\n\n{urgent}' },
    in_review: { subject: 'Tu reporte {reference} está en revisión',
      body: 'Una persona está revisando tu reporte {reference}.\n\nTe avisaremos cuando termine la revisión.\n\n{urgent}' },
    closed: { subject: 'Terminó la revisión de tu reporte {reference}',
      body: 'Una persona terminó de revisar tu reporte {reference}.\n\nEl banco te informará el resultado por su canal habitual.\n\n{urgent}' },
    update: { subject: 'Estado de tu reporte {reference}',
      body: 'Estado actual de tu reporte {reference}: {status}\n\nTe avisaremos si cambia.\n\n{urgent}' }
  },
  pt: {
    received: { subject: 'Recebemos seu relato {reference}',
      body: 'Recebemos seu relato de uma cobrança não reconhecida. Sua referência é {reference}.\n\nUma pessoa vai analisá-lo; avisaremos quando o status mudar.\n\n{urgent}' },
    in_review: { subject: 'Seu relato {reference} está em análise',
      body: 'Uma pessoa está analisando seu relato {reference}.\n\nAvisaremos quando a análise terminar.\n\n{urgent}' },
    closed: { subject: 'A análise do seu relato {reference} terminou',
      body: 'Uma pessoa terminou de analisar seu relato {reference}.\n\nO banco informará o resultado pelo canal habitual.\n\n{urgent}' },
    update: { subject: 'Status do seu relato {reference}',
      body: 'Status atual do seu relato {reference}: {status}\n\nAvisaremos se mudar.\n\n{urgent}' }
  },
  en: {
    received: { subject: 'We received your report {reference}',
      body: 'We received your report of an unrecognized charge. Your reference is {reference}.\n\nA person will review it; we will let you know when its status changes.\n\n{urgent}' },
    in_review: { subject: 'Your report {reference} is in review',
      body: 'A person is reviewing your report {reference}.\n\nWe will let you know when the review ends.\n\n{urgent}' },
    closed: { subject: 'The review of your report {reference} has ended',
      body: 'A person finished reviewing your report {reference}.\n\nThe bank will contact you about the outcome through its usual channel.\n\n{urgent}' },
    update: { subject: 'Status of your report {reference}',
      body: 'Current status of your report {reference}: {status}\n\nWe will let you know if it changes.\n\n{urgent}' }
  }
};

/** The ``{status}`` text of an ``update`` email, per stored report status. */
export const STATUS_TEXT = {
  received: { es: 'Recibido; una persona lo revisará', pt: 'Recebido; uma pessoa vai analisá-lo', en: 'Received; a person will review it' },
  in_review: { es: 'En revisión por una persona', pt: 'Em análise por uma pessoa', en: 'In review by a person' },
  closed: { es: 'Revisión terminada; el banco te contactará por su canal habitual',
    pt: 'Análise concluída; o banco vai entrar em contato pelo canal habitual',
    en: 'Review finished; the bank will contact you through its usual channel' }
};

import { LOGO_CID } from './logo.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Design-system tokens (light theme, `front-end/src/styles.css`); email clients need them inline. */
const C = { surface: '#f4f5f7', card: '#fcfcfd', line: '#e3e5ea', ink: '#121418', muted: '#5c6370', accent: '#2f55d4', onAccent: '#fbfcff', warn: '#935800', warnSoft: '#fbefd3' };
const FONT = "Geist, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif";
const MONO = "'Geist Mono', SFMono-Regular, Menlo, Consolas, monospace";

/**
 * The HTML version of a rendered email: logo header, body paragraphs, the reference in a mono box, the urgent note in a
 * warning box, a button to the app and the demo disclaimer. Table layout and inline styles only, so every client renders
 * it; no ``<style>`` block, so the markup carries no braces. The logo is the inline attachment ``cid:arabicaai-logo``
 * (``logo.js``), so it shows without any hosted file; ``appUrl`` (optional) is only the button target, and without it
 * there is no button.
 */
function html({ lang, subject, paragraphs, reference, urgent, appUrl }) {
  const base = appUrl ? appUrl.replace(/\/+$/, '') : null;
  const logo = `<img src="cid:${LOGO_CID}" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border-radius:16px">`;
  const p = text => `<p style="margin:0 0 14px;font:16px/24px ${FONT};color:${C.ink}">${esc(text)}</p>`;
  const refBox = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 20px"><tr><td style="padding:12px 16px;border:1px solid ${C.line};border-radius:12px;background:${C.surface}">`
    + `<div style="font:12px/16px ${FONT};color:${C.muted};text-transform:uppercase;letter-spacing:.04em">${REFERENCE_LABEL[lang]}</div>`
    + `<div style="font:600 24px/32px ${MONO};color:${C.ink}">${esc(reference)}</div></td></tr></table>`;
  const urgentBox = urgent ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 20px"><tr><td style="padding:12px 16px;border-radius:12px;background:${C.warnSoft};font:14px/22px ${FONT};color:${C.warn}">${esc(URGENT[lang].trim())}</td></tr></table>` : '';
  const button = base ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:4px 0 24px"><tr><td style="border-radius:999px;background:${C.accent}"><a href="${esc(base)}" style="display:inline-block;padding:12px 22px;font:600 15px/20px ${FONT};color:${C.onAccent};text-decoration:none">${CTA[lang]}</a></td></tr></table>` : '';
  const lines = FOOTER[lang].split('\n'); const noRefund = lines[0], disclaimer = lines.at(-1);
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(subject)}</title></head>`
    + `<body style="margin:0;padding:0;background:${C.surface}">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:${C.surface}"><tr><td align="center" style="padding:32px 16px">`
    + `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="max-width:560px;background:${C.card};border:1px solid ${C.line};border-radius:16px">`
    + `<tr><td style="padding:24px 28px 8px"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="padding-right:10px">${logo}</td><td style="font:600 18px/24px ${FONT};color:${C.ink}">Arabica<span style="font-weight:400">AI</span></td></tr></table></td></tr>`
    + `<tr><td style="padding:12px 28px 4px"><h1 style="margin:0 0 16px;font:600 22px/30px ${FONT};color:${C.ink}">${esc(subject)}</h1>${paragraphs.map(p).join('')}${refBox}${urgentBox}${button}`
    + `<p style="margin:0 0 20px;font:600 14px/22px ${FONT};color:${C.ink}">${esc(noRefund)}</p></td></tr>`
    + `<tr><td style="padding:16px 28px 24px;border-top:1px solid ${C.line};font:12px/18px ${FONT};color:${C.muted}">${esc(disclaimer)}</td></tr>`
    + `</table></td></tr></table></body></html>`;
}

/**
 * Render ``{ subject, text, html }``; only ``reference``, ``status``, ``urgent`` and ``appUrl`` are read, any other param is
 * ignored. Throws on an unknown template or language.
 */
export function render(template, lang, { reference, status = '', urgent = false, appUrl = null }) {
  const t = TEMPLATES[lang]?.[template];
  if (!t) throw new Error('Unknown template or language');
  const slots = { reference, status, urgent: urgent ? URGENT[lang] : '' };
  const fill = text => text.replace(/\{(reference|status|urgent)\}/g, (_, name) => slots[name]);
  const subject = fill(t.subject);
  // The HTML body carries the sentences without the urgent paragraph (it gets its own box) and without the footer.
  const paragraphs = fill(t.body.replace('{urgent}', '')).split('\n\n').map(s => s.trim()).filter(Boolean);
  return { subject, text: fill(t.body) + FOOTER[lang], html: html({ lang, subject, paragraphs, reference, urgent, appUrl }) };
}
