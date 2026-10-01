import { Injectable, computed, signal } from '@angular/core';
import { ApiError } from '../../core/http/api.service';

export type Lang = 'es' | 'pt' | 'en';

/** Every interface string, in the three required languages. Evidence (amounts, IDs, timestamps) is never translated. */
const es = {
    greeting: 'Hola', tagline: 'Reporta un cargo que no reconoces.',
    promise: 'Ves solo tus propios cargos, en tu idioma. Una persona revisa cada caso. Nadie mueve tu dinero.',
    start: 'Comenzar', continue: 'Continuar', sandbox: 'sandbox', synthetic: 'Datos sintéticos. Inicio de sesión simulado.',
    noMoney: 'Datos sintéticos. Nadie mueve tu dinero.',
    whoAreYou: '¿Quién eres?', chooseIdentity: 'Elige una identidad de demostración. El inicio de sesión es simulado.',
    onlyYours: 'Solo verás tus propios cargos.', promise1: 'Elige el cargo que no reconoces.', promise2: 'Cuéntanos qué pasó.',
    promise3: 'Una persona lo revisa. Nadie mueve tu dinero.', renew: 'Renovar la misma sesión',
    hello: 'Hola', loaded: 'cargos cargados', home: 'Inicio', charges: 'Cargos', agentView: 'Vista de agente',
    demoAccount: 'Cuenta de demostración', loadedCharges: 'Cargos cargados', currencies: 'Monedas',
    guideTitle: 'Reporte guiado', guideBlurb: 'Eliges el cargo, cuentas qué pasó y confirmas. Una persona revisa el caso.',
    report: 'Reportar un cargo', openCases: 'Casos abiertos', inReview: 'en revisión', accepted: 'aceptada', none: 'ninguno',
    recent: 'Cargos recientes', merchant: 'Comercio', date: 'Fecha', state: 'Estado', amount: 'Monto',
    notRecognized: 'No lo reconozco', selected: 'seleccionado', noMerchant: 'Comercio: no consta en la fuente',
    tzMissing: 'zona horaria no indicada', dateMissing: 'fecha no disponible', utc: 'UTC',
    coverage: 'Solo tus propios cargos, los más recientes al corte. No se muestran calificaciones de riesgo.',
    empty: 'No se cargaron cargos.', emptyCaveat: 'Esto no establece que el cliente no tenga cargos.',
    reportTitle: 'Reportar este cargo', describe: 'Describe lo que pasó', placeholder: 'No reconozco esta compra...',
    confirm: 'No reconozco el cargo seleccionado y quiero enviar una solicitud de revisión.',
    submit: 'Confirmar y enviar', retry: 'Reintentar la misma solicitud', cancel: 'Cancelar',
    pending: 'La aceptación no está confirmada. Mantén esta pestaña abierta y reintenta; los datos de la solicitud no cambian.',
    acceptedTitle: 'Solicitud aceptada en la demo', reference: 'Referencia', nextStep: 'Siguiente paso: un agente revisa este caso. No se ha iniciado ningún reembolso.',
    replayed: 'Se recuperó la solicitud existente; no se creó un caso nuevo.', working: 'Procesando…',
    byCurrency: 'Por moneda', total: 'Total de los cargos cargados', count: 'cargos',
    agentTitle: 'Vista de agente', agentIntro: 'Acceso de agente simulado y separado. Muestra los 50 casos más recientes.',
    agentLoad: 'Entrar como agente y actualizar casos', noCases: 'No se devolvieron casos.', customer: 'Cliente', acceptedAt: 'Aceptada en la demo',
    validation: 'Selecciona un cargo, describe el problema en al menos 10 caracteres y confirma.',
    mainNav: 'Principal', language: 'Idioma',
    err401: 'La sesión expiró. Vuelve a entrar con la misma identidad para continuar.',
    err404: 'No se encontró el cargo para esta sesión.',
    err409: 'Esta clave de solicitud ya se usó con otro contenido. No inicies otra solicitud; pide a un agente que revise el caso.',
    err413: 'La descripción es demasiado larga.', err422: 'Revisa los campos y confirma la solicitud.',
    err503: 'Servicio no disponible. La aceptación no se confirmó. Reintenta la misma solicitud.', errOther: 'La solicitud falló.',
    // W3 fe-customer-picker
    pickerSearch: 'Buscar por nombre o ID', pickerCountry: 'País', pickerAllCountries: 'Todos los países',
    pickerNoCountry: 'Sin país indicado', pickerMatches: 'coincidencias', pickerNone: 'Ninguna identidad coincide.',
    pickerRefine: 'Solo se muestran las primeras coincidencias. Afina la búsqueda.'
};

/** The key set is the Spanish table; the other two must match it exactly. */
export type Strings = { [K in keyof typeof es]: string };

const STRINGS: Record<Lang, Strings> = {
  es,
  pt: {
    greeting: 'Olá', tagline: 'Reporte uma cobrança que você não reconhece.',
    promise: 'Você vê apenas suas próprias cobranças, no seu idioma. Uma pessoa analisa cada caso. Ninguém mexe no seu dinheiro.',
    start: 'Começar', continue: 'Continuar', sandbox: 'sandbox', synthetic: 'Dados sintéticos. Login simulado.',
    noMoney: 'Dados sintéticos. Ninguém mexe no seu dinheiro.',
    whoAreYou: 'Quem é você?', chooseIdentity: 'Escolha uma identidade de demonstração. O login é simulado.',
    onlyYours: 'Você verá apenas suas próprias cobranças.', promise1: 'Escolha a cobrança que não reconhece.', promise2: 'Conte o que aconteceu.',
    promise3: 'Uma pessoa analisa. Ninguém mexe no seu dinheiro.', renew: 'Renovar a mesma sessão',
    hello: 'Olá', loaded: 'cobranças carregadas', home: 'Início', charges: 'Cobranças', agentView: 'Visão do agente',
    demoAccount: 'Conta de demonstração', loadedCharges: 'Cobranças carregadas', currencies: 'Moedas',
    guideTitle: 'Relato guiado', guideBlurb: 'Você escolhe a cobrança, conta o que aconteceu e confirma. Uma pessoa analisa o caso.',
    report: 'Reportar uma cobrança', openCases: 'Casos abertos', inReview: 'em análise', accepted: 'aceito', none: 'nenhum',
    recent: 'Cobranças recentes', merchant: 'Estabelecimento', date: 'Data', state: 'Estado', amount: 'Valor',
    notRecognized: 'Não reconheço', selected: 'selecionado', noMerchant: 'Estabelecimento: não consta na fonte',
    tzMissing: 'fuso horário não informado', dateMissing: 'data indisponível', utc: 'UTC',
    coverage: 'Apenas suas próprias cobranças, as mais recentes no corte. Nenhuma pontuação de risco é exibida.',
    empty: 'Nenhuma cobrança carregada.', emptyCaveat: 'Isso não estabelece que o cliente não tenha cobranças.',
    reportTitle: 'Reportar esta cobrança', describe: 'Descreva o que aconteceu', placeholder: 'Não reconheço esta compra...',
    confirm: 'Não reconheço a cobrança selecionada e quero enviar um pedido de revisão.',
    submit: 'Confirmar e enviar', retry: 'Tentar o mesmo pedido novamente', cancel: 'Cancelar',
    pending: 'A aceitação não está confirmada. Mantenha esta aba aberta e tente novamente; os dados do pedido não mudam.',
    acceptedTitle: 'Pedido aceito na demo', reference: 'Referência', nextStep: 'Próximo passo: um agente analisa este caso. Nenhum reembolso foi iniciado.',
    replayed: 'Pedido existente recuperado; nenhum caso novo foi criado.', working: 'Processando…',
    byCurrency: 'Por moeda', total: 'Total das cobranças carregadas', count: 'cobranças',
    agentTitle: 'Visão do agente', agentIntro: 'Acesso de agente simulado e separado. Mostra os 50 casos mais recentes.',
    agentLoad: 'Entrar como agente e atualizar casos', noCases: 'Nenhum caso retornado.', customer: 'Cliente', acceptedAt: 'Aceito na demo',
    validation: 'Selecione uma cobrança, descreva o problema em pelo menos 10 caracteres e confirme.',
    mainNav: 'Principal', language: 'Idioma',
    err401: 'A sessão expirou. Entre novamente com a mesma identidade para continuar.',
    err404: 'Cobrança não encontrada para esta sessão.',
    err409: 'Esta chave de pedido já foi usada com outro conteúdo. Não inicie outro pedido; peça a um agente que verifique o caso.',
    err413: 'A descrição é longa demais.', err422: 'Revise os campos e confirme o pedido.',
    err503: 'Serviço indisponível. A aceitação não foi confirmada. Tente o mesmo pedido novamente.', errOther: 'O pedido falhou.',
    // W3 fe-customer-picker
    pickerSearch: 'Buscar por nome ou ID', pickerCountry: 'País', pickerAllCountries: 'Todos os países',
    pickerNoCountry: 'Sem país informado', pickerMatches: 'resultados', pickerNone: 'Nenhuma identidade corresponde.',
    pickerRefine: 'Apenas os primeiros resultados são exibidos. Refine a busca.'
  },
  en: {
    greeting: 'Hello', tagline: 'Report a charge you do not recognize.',
    promise: 'You see only your own charges, in your language. A person reviews every case. Nobody moves your money.',
    start: 'Start', continue: 'Continue', sandbox: 'sandbox', synthetic: 'Synthetic data. Simulated sign-in.',
    noMoney: 'Synthetic data. Nobody moves your money.',
    whoAreYou: 'Who are you?', chooseIdentity: 'Choose a demo identity. Sign-in is simulated.',
    onlyYours: 'You will only see your own charges.', promise1: 'Pick the charge you do not recognize.', promise2: 'Tell us what happened.',
    promise3: 'A person reviews it. Nobody moves your money.', renew: 'Renew the same session',
    hello: 'Hi', loaded: 'charges loaded', home: 'Home', charges: 'Charges', agentView: 'Agent view',
    demoAccount: 'Demo account', loadedCharges: 'Charges loaded', currencies: 'Currencies',
    guideTitle: 'Guided report', guideBlurb: 'You pick the charge, say what happened and confirm. A person reviews the case.',
    report: 'Report a charge', openCases: 'Open cases', inReview: 'in review', accepted: 'accepted', none: 'none',
    recent: 'Recent charges', merchant: 'Merchant', date: 'Date', state: 'State', amount: 'Amount',
    notRecognized: 'I do not recognize it', selected: 'selected', noMerchant: 'Merchant: not in source',
    tzMissing: 'source timezone not provided', dateMissing: 'date unavailable', utc: 'UTC',
    coverage: 'Only your own charges, the most recent at the cutoff. No risk scores are shown.',
    empty: 'No charges loaded.', emptyCaveat: 'This does not establish that the customer has no charges.',
    reportTitle: 'Report this charge', describe: 'Describe what happened', placeholder: 'I do not recognize this purchase...',
    confirm: 'I do not recognize the selected charge and want to submit a review request.',
    submit: 'Confirm and submit', retry: 'Retry the same request', cancel: 'Cancel',
    pending: 'Acceptance is not confirmed. Keep this tab open and retry; the request details are unchanged.',
    acceptedTitle: 'Request accepted in the demo', reference: 'Reference', nextStep: 'Next step: an agent reviews this case. No refund has been initiated.',
    replayed: 'Existing request retrieved; no new case was created.', working: 'Working…',
    byCurrency: 'By currency', total: 'Total of the loaded charges', count: 'charges',
    agentTitle: 'Agent view', agentIntro: 'Separate simulated agent access. Shows the 50 most recent cases.',
    agentLoad: 'Sign in as an agent and refresh cases', noCases: 'No cases returned.', customer: 'Customer', acceptedAt: 'Accepted in demo',
    validation: 'Select a charge, describe the issue in at least 10 characters, and confirm.',
    mainNav: 'Main', language: 'Language',
    err401: 'Session expired. Sign in again with the same identity to continue.',
    err404: 'Charge not found for this session.',
    err409: 'This request key was used for different content. Do not start another request; ask an agent to check the case.',
    err413: 'The description is too long.', err422: 'Check the fields and confirm the request.',
    err503: 'Service unavailable. Acceptance was not confirmed. Retry the same request.', errOther: 'Request failed.',
    // W3 fe-customer-picker
    pickerSearch: 'Search by name or ID', pickerCountry: 'Country', pickerAllCountries: 'All countries',
    pickerNoCountry: 'No country listed', pickerMatches: 'matches', pickerNone: 'No identity matches.',
    pickerRefine: 'Only the first matches are shown. Refine your search.'
  }
};

/** The interface language. It comes from the visitor's choice, else the browser, never from the customer's country. */
@Injectable({ providedIn: 'root' })
export class LangService {
  readonly lang = signal<Lang>(LangService.initial());
  readonly t = computed<Strings>(() => STRINGS[this.lang()]);
  readonly all: Lang[] = ['es', 'pt', 'en'];

  constructor() {
    if (typeof document !== 'undefined') document.documentElement.lang = this.lang();
  }

  set(lang: Lang): void {
    this.lang.set(lang);
    try { localStorage.setItem('arabica.lang', lang); } catch { /* storage may be unavailable */ }
    if (typeof document !== 'undefined') document.documentElement.lang = lang;
  }

  private static initial(): Lang {
    try {
      const saved = localStorage.getItem('arabica.lang');
      if (saved === 'es' || saved === 'pt' || saved === 'en') return saved;
    } catch { /* ignore */ }
    const nav = typeof navigator !== 'undefined' ? navigator.language.slice(0, 2) : 'es';
    return nav === 'pt' ? 'pt' : nav === 'en' ? 'en' : 'es';
  }
}

const ERROR_KEYS: Record<number, keyof Strings> = { 0: 'err503', 401: 'err401', 404: 'err404', 409: 'err409', 413: 'err413', 422: 'err422', 503: 'err503' };

/** The customer-facing text for a failed call, in the interface language. Server text is never shown; status 0 (no answer) reads as 503. */
export function errorText(t: Strings, e: unknown): string {
  if (!(e instanceof ApiError)) return t.errOther;
  const key = ERROR_KEYS[e.status];
  return key ? t[key] : `${t.errOther} (HTTP ${e.status})`;
}
