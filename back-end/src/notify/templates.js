/**
 * Notification email text in Spanish, Portuguese and English. Slots: ``{reference}``, ``{status}`` (``update`` only)
 * and ``{urgent}``. Bodies never carry the customer's statement and never call a report resolved: a person reviews
 * it and no refund has been started.
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

/** The ``{status}`` text of an ``update`` email, per stored report status (today every report is ``received``). */
export const STATUS_TEXT = {
  received: { es: 'Recibido; una persona lo revisará', pt: 'Recebido; uma pessoa vai analisá-lo', en: 'Received; a person will review it' }
};

/** Render ``{ subject, text }``; only ``reference``, ``status`` and ``urgent`` are read, any other param is ignored. Throws on an unknown template or language. */
export function render(template, lang, { reference, status = '', urgent = false }) {
  const t = TEMPLATES[lang]?.[template];
  if (!t) throw new Error('Unknown template or language');
  const slots = { reference, status, urgent: urgent ? URGENT[lang] : '' };
  const fill = text => text.replace(/\{(reference|status|urgent)\}/g, (_, name) => slots[name]);
  return { subject: fill(t.subject), text: fill(t.body) + FOOTER[lang] };
}
