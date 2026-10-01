import { Injectable, computed, signal } from '@angular/core';
import { ApiError } from '../../core/http/api.service';

export type Lang = 'es' | 'pt' | 'en';

/** Every interface string, in the three required languages. Evidence (amounts, IDs, timestamps) is never translated. */
const es = {
    greeting: 'Hola', tagline: 'Reporta un cargo que no reconoces.',
    explain1: 'Eliges el cargo que no reconoces y cuentas qué pasó.', explain2: 'Una persona del banco revisa cada reporte.',
    explain3: 'Nada se reembolsa, bloquea ni se decide aquí.',
    continue: 'Continuar', sandbox: 'sandbox', synthetic: 'Datos sintéticos. Inicio de sesión simulado.',
    noMoney: 'Datos sintéticos. Nadie mueve tu dinero.',
    whoAreYou: '¿Quién eres?', chooseIdentity: 'Elige una identidad de demostración. El inicio de sesión es simulado.',
    renew: 'Renovar la misma sesión',
    hello: 'Hola', loaded: 'cargos cargados', home: 'Inicio', charges: 'Cargos', agentView: 'Vista de agente',
    demoAccount: 'Cuenta de demostración', loadedCharges: 'Cargos cargados', currencies: 'Monedas',
    guideTitle: 'Reporte guiado', guideBlurb: 'Eliges el cargo, cuentas qué pasó y confirmas. Una persona revisa el caso.',
    report: 'Reportar un cargo', openCases: 'Casos abiertos', inReview: 'en revisión', accepted: 'aceptada', none: 'ninguno',
    recent: 'Cargos recientes', merchant: 'Comercio', date: 'Fecha', state: 'Estado', amount: 'Monto',
    selected: 'seleccionado', noMerchant: 'Comercio: no consta en la fuente',
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
    // Customer picker
    pickerSearch: 'Buscar por nombre o ID', pickerCountry: 'País', pickerAllCountries: 'Todos los países',
    pickerNoCountry: 'Sin país indicado', pickerMatches: 'coincidencias', pickerNone: 'Ninguna identidad coincide.',
    pickerRefine: 'Solo se muestran las primeras coincidencias. Afina la búsqueda.',
    pickerMatch: 'coincidencia',
    // Agent intake console
    intakeQueue: 'Cola de reportes guiados', intakeDetail: 'Detalle del reporte', noIntakes: 'No se devolvieron reportes guiados.',
    queueMore: 'Solo se muestran los 50 más recientes.', historyMore: 'Solo se muestran los primeros 100 eventos.',
    kindComplete: 'Completo', kindTechnical: 'Falla técnica', kindIncomplete: 'Incompleto',
    transactionId: 'ID de transacción', evidence: 'Evidencia verificada', noEvidence: 'Sin transacción verificada.',
    openQuestions: 'Preguntas abiertas', history: 'Historial',
    toolStatus: 'Estado de la consulta', destination: 'Destino', priority: 'Prioridad', close: 'Cerrar',
    statement: 'Relato del cliente', languageCode: 'Idioma del reporte',
    agentErr401: 'La sesión de agente expiró. Vuelve a entrar como agente.', agentErr404: 'No se encontró el reporte.',
    // Guided intake chat
    chatOpen: 'Abrir el reporte guiado', chatClose: 'Cerrar el reporte guiado', chatYou: 'Tú', chatGuide: 'Guía',
    chatHello: 'Cuéntame qué pasó con el cargo que no reconoces. Después eliges el cargo y confirmas.',
    chatLangPrompt: 'Idioma del reporte', chatSend: 'Enviar',
    chatValidation: 'Elige el idioma del reporte y describe lo que pasó en al menos 10 caracteres.',
    chatChoose: 'Elige el cargo entre tus cargos y confírmalo. Si no lo encuentras, pide revisión sin cargo.',
    chatChooseValidation: 'Elige uno de tus cargos y marca la confirmación.', chatConfirmCharge: 'Confirmar este cargo',
    chatCannotFind: 'No encuentro el cargo', chatNew: 'Iniciar un nuevo reporte', chatFaq: 'Preguntas frecuentes',
    faqNextQ: '¿Qué pasa después de enviarlo?',
    faqNextA: 'Una persona del equipo del banco revisa tu reporte. Solo ves una referencia cuando quedó guardado. Esta demo no reembolsa, no bloquea tarjetas ni decide sobre fraude.',
    faqTimeQ: '¿Cuánto tarda?', faqTimeA: 'Esta demo no fija un plazo de revisión. Guarda tu referencia: identifica tu reporte.',
    faqMissingQ: '¿Y si no encuentro el cargo?', faqMissingA: 'Elige «No encuentro el cargo» y una persona revisa tu reporte sin un cargo confirmado.',
    receiptComplete: 'Reporte aceptado en la demo',
    receiptIncomplete: 'Enviado a revisión humana sin un cargo confirmado',
    receiptTechnical: 'No pudimos verificar el cargo; enviado a revisión humana',
    products: 'Productos', notListed: 'no consta', chipPending: 'sin confirmar',
    moreCharges: 'Hay más cargos que no se muestran aquí.',
    err409Finish: 'Este reporte ya no se puede cambiar. Si no recibiste una referencia, inicia un nuevo reporte.',
    chatValidationShort: 'Describe lo que pasó en al menos 10 caracteres.',
    // Purpose, report button, what we checked
    reportCharge: 'Reportar', whatWeChecked: 'Lo que verificamos',
    check_owned_transaction_retrieved: 'Cargo encontrado entre los cargos de la cuenta',
    check_customer_confirmation_recorded: 'Confirmación del cargo registrada',
    check_transaction_lookup_failed: 'La búsqueda del cargo falló',
    check_matching_transaction: 'Cargo sin identificar', check_customer_confirmation: 'Confirmación del cargo pendiente'
};

/** The key set is the Spanish table; the other two must match it exactly. */
export type Strings = { [K in keyof typeof es]: string };

const STRINGS: Record<Lang, Strings> = {
  es,
  pt: {
    greeting: 'Olá', tagline: 'Reporte uma cobrança que você não reconhece.',
    explain1: 'Você escolhe a cobrança que não reconhece e conta o que aconteceu.', explain2: 'Uma pessoa do banco analisa cada relato.',
    explain3: 'Nada é reembolsado, bloqueado nem decidido aqui.',
    continue: 'Continuar', sandbox: 'sandbox', synthetic: 'Dados sintéticos. Login simulado.',
    noMoney: 'Dados sintéticos. Ninguém mexe no seu dinheiro.',
    whoAreYou: 'Quem é você?', chooseIdentity: 'Escolha uma identidade de demonstração. O login é simulado.',
    renew: 'Renovar a mesma sessão',
    hello: 'Olá', loaded: 'cobranças carregadas', home: 'Início', charges: 'Cobranças', agentView: 'Visão do agente',
    demoAccount: 'Conta de demonstração', loadedCharges: 'Cobranças carregadas', currencies: 'Moedas',
    guideTitle: 'Relato guiado', guideBlurb: 'Você escolhe a cobrança, conta o que aconteceu e confirma. Uma pessoa analisa o caso.',
    report: 'Reportar uma cobrança', openCases: 'Casos abertos', inReview: 'em análise', accepted: 'aceito', none: 'nenhum',
    recent: 'Cobranças recentes', merchant: 'Estabelecimento', date: 'Data', state: 'Estado', amount: 'Valor',
    selected: 'selecionado', noMerchant: 'Estabelecimento: não consta na fonte',
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
    // Customer picker
    pickerSearch: 'Buscar por nome ou ID', pickerCountry: 'País', pickerAllCountries: 'Todos os países',
    pickerNoCountry: 'Sem país informado', pickerMatches: 'resultados', pickerNone: 'Nenhuma identidade corresponde.',
    pickerRefine: 'Apenas os primeiros resultados são exibidos. Refine a busca.',
    pickerMatch: 'resultado',
    // Agent intake console
    intakeQueue: 'Fila de relatos guiados', intakeDetail: 'Detalhe do relato', noIntakes: 'Nenhum relato guiado retornado.',
    queueMore: 'Apenas os 50 mais recentes são exibidos.', historyMore: 'Apenas os primeiros 100 eventos são exibidos.',
    kindComplete: 'Completo', kindTechnical: 'Falha técnica', kindIncomplete: 'Incompleto',
    transactionId: 'ID da transação', evidence: 'Evidência verificada', noEvidence: 'Sem transação verificada.',
    openQuestions: 'Perguntas em aberto', history: 'Histórico',
    toolStatus: 'Status da consulta', destination: 'Destino', priority: 'Prioridade', close: 'Fechar',
    statement: 'Relato do cliente', languageCode: 'Idioma do relato',
    agentErr401: 'A sessão de agente expirou. Entre novamente como agente.', agentErr404: 'Relato não encontrado.',
    // Guided intake chat
    chatOpen: 'Abrir o relato guiado', chatClose: 'Fechar o relato guiado', chatYou: 'Você', chatGuide: 'Guia',
    chatHello: 'Conte o que aconteceu com a cobrança que você não reconhece. Depois você escolhe a cobrança e confirma.',
    chatLangPrompt: 'Idioma do relato', chatSend: 'Enviar',
    chatValidation: 'Escolha o idioma do relato e descreva o que aconteceu em pelo menos 10 caracteres.',
    chatChoose: 'Escolha a cobrança entre as suas e confirme. Se não a encontrar, peça análise sem cobrança.',
    chatChooseValidation: 'Escolha uma das suas cobranças e marque a confirmação.', chatConfirmCharge: 'Confirmar esta cobrança',
    chatCannotFind: 'Não encontro a cobrança', chatNew: 'Iniciar um novo relato', chatFaq: 'Perguntas frequentes',
    faqNextQ: 'O que acontece depois que eu enviar?',
    faqNextA: 'Uma pessoa da equipe do banco analisa o seu relato. Você só vê uma referência quando ele foi salvo. Esta demo não reembolsa, não bloqueia cartões nem decide sobre fraude.',
    faqTimeQ: 'Quanto tempo leva?', faqTimeA: 'Esta demo não define um prazo de análise. Guarde a sua referência: ela identifica o seu relato.',
    faqMissingQ: 'E se eu não encontrar a cobrança?', faqMissingA: 'Escolha «Não encontro a cobrança» e uma pessoa analisa o seu relato sem uma cobrança confirmada.',
    receiptComplete: 'Relato aceito na demo',
    receiptIncomplete: 'Enviado para análise humana sem uma cobrança confirmada',
    receiptTechnical: 'Não conseguimos verificar a cobrança; enviado para análise humana',
    products: 'Produtos', notListed: 'não consta', chipPending: 'não confirmado',
    moreCharges: 'Há mais cobranças que não aparecem aqui.',
    err409Finish: 'Este relato não pode mais ser alterado. Se você não recebeu uma referência, inicie um novo relato.',
    chatValidationShort: 'Descreva o que aconteceu em pelo menos 10 caracteres.',
    // Purpose, report button, what we checked
    reportCharge: 'Reportar', whatWeChecked: 'O que verificamos',
    check_owned_transaction_retrieved: 'Cobrança encontrada entre as cobranças da conta',
    check_customer_confirmation_recorded: 'Confirmação da cobrança registrada',
    check_transaction_lookup_failed: 'A busca da cobrança falhou',
    check_matching_transaction: 'Cobrança não identificada', check_customer_confirmation: 'Confirmação da cobrança pendente'
  },
  en: {
    greeting: 'Hello', tagline: 'Report a charge you do not recognize.',
    explain1: 'You pick the charge you do not recognize and say what happened.', explain2: 'A person at the bank reviews every report.',
    explain3: 'Nothing is refunded, blocked or decided here.',
    continue: 'Continue', sandbox: 'sandbox', synthetic: 'Synthetic data. Simulated sign-in.',
    noMoney: 'Synthetic data. Nobody moves your money.',
    whoAreYou: 'Who are you?', chooseIdentity: 'Choose a demo identity. Sign-in is simulated.',
    renew: 'Renew the same session',
    hello: 'Hi', loaded: 'charges loaded', home: 'Home', charges: 'Charges', agentView: 'Agent view',
    demoAccount: 'Demo account', loadedCharges: 'Charges loaded', currencies: 'Currencies',
    guideTitle: 'Guided report', guideBlurb: 'You pick the charge, say what happened and confirm. A person reviews the case.',
    report: 'Report a charge', openCases: 'Open cases', inReview: 'in review', accepted: 'accepted', none: 'none',
    recent: 'Recent charges', merchant: 'Merchant', date: 'Date', state: 'State', amount: 'Amount',
    selected: 'selected', noMerchant: 'Merchant: not in source',
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
    // Customer picker
    pickerSearch: 'Search by name or ID', pickerCountry: 'Country', pickerAllCountries: 'All countries',
    pickerNoCountry: 'No country listed', pickerMatches: 'matches', pickerNone: 'No identity matches.',
    pickerRefine: 'Only the first matches are shown. Refine your search.',
    pickerMatch: 'match',
    // Agent intake console
    intakeQueue: 'Guided report queue', intakeDetail: 'Report detail', noIntakes: 'No guided reports returned.',
    queueMore: 'Only the newest 50 are shown.', historyMore: 'Only the first 100 events are shown.',
    kindComplete: 'Complete', kindTechnical: 'Technical failure', kindIncomplete: 'Incomplete',
    transactionId: 'Transaction ID', evidence: 'Verified evidence', noEvidence: 'No verified transaction.',
    openQuestions: 'Open questions', history: 'History',
    toolStatus: 'Lookup status', destination: 'Destination', priority: 'Priority', close: 'Close',
    statement: 'Customer statement', languageCode: 'Report language',
    agentErr401: 'The agent session expired. Sign in as an agent again.', agentErr404: 'Report not found.',
    // Guided intake chat
    chatOpen: 'Open the guided report', chatClose: 'Close the guided report', chatYou: 'You', chatGuide: 'Guide',
    chatHello: 'Tell me what happened with the charge you do not recognize. Then you choose the charge and confirm.',
    chatLangPrompt: 'Report language', chatSend: 'Send',
    chatValidation: 'Choose the report language and describe what happened in at least 10 characters.',
    chatChoose: "Choose the charge from your charges and confirm it. If you can't find it, ask for review without a charge.",
    chatChooseValidation: 'Choose one of your charges and tick the confirmation.', chatConfirmCharge: 'Confirm this charge',
    chatCannotFind: "I can't find the charge", chatNew: 'Start a new report', chatFaq: 'Frequent questions',
    faqNextQ: 'What happens after I send it?',
    faqNextA: 'A person on the bank team reviews your report. You see a reference only once it is saved. This demo does not refund, block cards or decide fraud.',
    faqTimeQ: 'How long does it take?', faqTimeA: 'This demo does not set a review time. Keep your reference; it identifies your report.',
    faqMissingQ: "What if I can't find the charge?", faqMissingA: "Choose 'I can't find the charge' and a person reviews your report without a confirmed charge.",
    receiptComplete: 'Report accepted in the demo',
    receiptIncomplete: 'Sent for human review without a confirmed charge',
    receiptTechnical: 'We could not check the charge; sent for human review',
    products: 'Products', notListed: 'not listed', chipPending: 'not confirmed',
    moreCharges: 'There are more charges that are not shown here.',
    err409Finish: 'This report can no longer be changed. If you did not receive a reference, start a new report.',
    chatValidationShort: 'Describe what happened in at least 10 characters.',
    // Purpose, report button, what we checked
    reportCharge: 'Report', whatWeChecked: 'What we checked',
    check_owned_transaction_retrieved: "Charge found among the account's own charges",
    check_customer_confirmation_recorded: 'Charge confirmation recorded',
    check_transaction_lookup_failed: 'Charge lookup failed',
    check_matching_transaction: 'Charge not identified', check_customer_confirmation: 'Charge confirmation pending'
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

/** A server check or open-question code in the interface language; a code without a label is shown as is. */
export function checkText(t: Strings, code: string): string {
  return (t as Record<string, string>)['check_' + code] ?? code;
}
