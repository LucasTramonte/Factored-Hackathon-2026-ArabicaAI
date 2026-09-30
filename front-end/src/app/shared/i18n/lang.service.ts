import { Injectable, computed, signal } from '@angular/core';

export type Lang = 'es' | 'pt' | 'en';

/** Every interface string, in the three required languages. Evidence (amounts, IDs, timestamps) is never translated. */
const es = {
    greeting: 'Hola', tagline: 'Agentes creados para ti.',
    promise: 'Tu agente conoce tus cargos, tu idioma y tu banco. Una persona revisa cada caso. Nadie mueve tu dinero.',
    start: 'Comenzar', continue: 'Continuar', sandbox: 'sandbox', synthetic: 'Datos sintéticos. Inicio de sesión simulado.',
    noMoney: 'Datos sintéticos. Nadie mueve tu dinero.',
    whoAreYou: '¿Quién eres?', chooseIdentity: 'Elige una identidad de demostración. El inicio de sesión es simulado.',
    onlyYours: 'Solo verás tus propios cargos.', promise1: 'Elige el cargo que no reconoces.', promise2: 'Cuéntanos qué pasó.',
    promise3: 'Una persona lo revisa. Nadie mueve tu dinero.', renew: 'Renovar la misma sesión',
    hello: 'Hola', loaded: 'cargos cargados', home: 'Inicio', charges: 'Cargos', agentView: 'Vista de agente',
    demoAccount: 'Cuenta de demostración', loadedCharges: 'Cargos cargados', currencies: 'Monedas',
    yourAgent: 'Tu agente', agentBlurb: 'Creado para ti: conoce tu idioma, tu identidad y tus cargos cargados. Prepara tu caso; una persona lo revisa.',
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
    validation: 'Selecciona un cargo, describe el problema en al menos 10 caracteres y confirma.'
};

/** The key set is the Spanish table; the other two must match it exactly. */
export type Strings = { [K in keyof typeof es]: string };

const STRINGS: Record<Lang, Strings> = {
  es,
  pt: {
    greeting: 'Olá', tagline: 'Agentes criados para você.',
    promise: 'Seu agente conhece suas cobranças, seu idioma e seu banco. Uma pessoa analisa cada caso. Ninguém mexe no seu dinheiro.',
    start: 'Começar', continue: 'Continuar', sandbox: 'sandbox', synthetic: 'Dados sintéticos. Login simulado.',
    noMoney: 'Dados sintéticos. Ninguém mexe no seu dinheiro.',
    whoAreYou: 'Quem é você?', chooseIdentity: 'Escolha uma identidade de demonstração. O login é simulado.',
    onlyYours: 'Você verá apenas suas próprias cobranças.', promise1: 'Escolha a cobrança que não reconhece.', promise2: 'Conte o que aconteceu.',
    promise3: 'Uma pessoa analisa. Ninguém mexe no seu dinheiro.', renew: 'Renovar a mesma sessão',
    hello: 'Olá', loaded: 'cobranças carregadas', home: 'Início', charges: 'Cobranças', agentView: 'Visão do agente',
    demoAccount: 'Conta de demonstração', loadedCharges: 'Cobranças carregadas', currencies: 'Moedas',
    yourAgent: 'Seu agente', agentBlurb: 'Criado para você: conhece seu idioma, sua identidade e suas cobranças carregadas. Prepara seu caso; uma pessoa analisa.',
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
    validation: 'Selecione uma cobrança, descreva o problema em pelo menos 10 caracteres e confirme.'
  },
  en: {
    greeting: 'Hello', tagline: 'Agents built for you.',
    promise: 'Your agent knows your charges, your language and your bank. A person reviews every case. Nobody moves your money.',
    start: 'Start', continue: 'Continue', sandbox: 'sandbox', synthetic: 'Synthetic data. Simulated sign-in.',
    noMoney: 'Synthetic data. Nobody moves your money.',
    whoAreYou: 'Who are you?', chooseIdentity: 'Choose a demo identity. Sign-in is simulated.',
    onlyYours: 'You will only see your own charges.', promise1: 'Pick the charge you do not recognize.', promise2: 'Tell us what happened.',
    promise3: 'A person reviews it. Nobody moves your money.', renew: 'Renew the same session',
    hello: 'Hi', loaded: 'charges loaded', home: 'Home', charges: 'Charges', agentView: 'Agent view',
    demoAccount: 'Demo account', loadedCharges: 'Charges loaded', currencies: 'Currencies',
    yourAgent: 'Your agent', agentBlurb: 'Built for you: it knows your language, your identity and your loaded charges. It prepares your case; a person reviews it.',
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
    validation: 'Select a charge, describe the issue in at least 10 characters, and confirm.'
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
