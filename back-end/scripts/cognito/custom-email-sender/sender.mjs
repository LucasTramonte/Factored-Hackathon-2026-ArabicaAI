const COPY = {
  es: { auth: ['Tu código ArabicaAI', 'Tu código de acceso', 'Escríbelo en la pantalla de inicio de sesión.'], confirm: ['Confirma tu cuenta ArabicaAI', 'Confirma tu cuenta', 'Usa este código para confirmar tu cuenta.'], reset: ['Restablece tu contraseña ArabicaAI', 'Restablece tu contraseña', 'Usa este código en la pantalla de restablecimiento de contraseña.'], attribute: ['Verifica tus datos ArabicaAI', 'Verifica tus datos', 'Usa este código para verificar el cambio solicitado.'], invite: ['Tu invitación ArabicaAI', 'Te han invitado a ArabicaAI', 'Usa tu correo y esta contraseña temporal para iniciar sesión y elegir una contraseña nueva.'], takeover: ['Alerta de seguridad ArabicaAI', 'Actividad sospechosa', 'Se detectó un intento sospechoso de acceder a tu cuenta. Contacta al administrador si no lo reconoces.'], footer: 'ArabicaAI es una demostración con datos sintéticos; no es un servicio bancario real.', note: 'Si no lo pediste, ignora este correo. No compartas este código.' },
  pt: { auth: ['Seu código ArabicaAI', 'Seu código de acesso', 'Digite-o na tela de entrada.'], confirm: ['Confirme sua conta ArabicaAI', 'Confirme sua conta', 'Use este código para confirmar sua conta.'], reset: ['Redefina sua senha ArabicaAI', 'Redefina sua senha', 'Use este código na tela de redefinição de senha.'], attribute: ['Verifique seus dados ArabicaAI', 'Verifique seus dados', 'Use este código para verificar a alteração solicitada.'], invite: ['Seu convite ArabicaAI', 'Você foi convidado para ArabicaAI', 'Use seu e-mail e esta senha temporária para entrar e escolher uma nova senha.'], takeover: ['Alerta de segurança ArabicaAI', 'Atividade suspeita', 'Uma tentativa suspeita de acessar sua conta foi detectada. Contate o administrador se não a reconhecer.'], footer: 'ArabicaAI é uma demonstração com dados sintéticos; não é um serviço bancário real.', note: 'Se você não o pediu, ignore este e-mail. Não compartilhe este código.' },
  en: { auth: ['Your ArabicaAI code', 'Your sign-in code', 'Enter it on the sign-in screen.'], confirm: ['Confirm your ArabicaAI account', 'Confirm your account', 'Use this code to confirm your account.'], reset: ['Reset your ArabicaAI password', 'Reset your password', 'Use this code on the password reset screen.'], attribute: ['Verify your ArabicaAI details', 'Verify your details', 'Use this code to verify the requested change.'], invite: ['Your ArabicaAI invitation', 'You are invited to ArabicaAI', 'Use your email and this temporary password to sign in and choose a new password.'], takeover: ['ArabicaAI security alert', 'Suspicious activity', 'A suspicious attempt to access your account was detected. Contact the administrator if you do not recognize it.'], footer: 'ArabicaAI is a demo with synthetic data; it is not a real banking service.', note: 'If you did not request this, ignore this email. Do not share this code.' },
};
const TYPES = { Authentication: 'auth', SignUp: 'confirm', ResendCode: 'confirm', ForgotPassword: 'reset', UpdateUserAttribute: 'attribute', VerifyUserAttribute: 'attribute', AdminCreateUser: 'invite', AccountTakeOverNotification: 'takeover' };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// Cognito HTML-escapes only < and > in temporary passwords before encryption.
const password = value => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** Render a supported Cognito message; locale changes presentation only. */
export function render(source, locale, secret = '') {
  const type = TYPES[source?.replace(/^CustomEmailSender_/, '')];
  if (!source?.startsWith('CustomEmailSender_') || !type) throw new Error('Unsupported message');
  const lang = Object.hasOwn(COPY, locale) ? locale : 'es';
  const copy = COPY[lang];
  const [subject, title, instruction] = copy[type];
  const value = type === 'invite' ? password(secret) : secret;
  const text = [title, instruction, value, type === 'takeover' ? '' : copy.note, copy.footer].filter(Boolean).join('\n\n');
  const html = `<!doctype html><html lang="${lang}"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:#f4f5f7"><table role="presentation" width="100%"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" style="max-width:560px;background:#fcfcfd;border:1px solid #e3e5ea;border-radius:16px"><tr><td align="center" style="padding:24px 20px;text-align:center;font:15px/22px Arial,sans-serif;color:#121418"><table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto"><tr><td style="padding-right:10px"><img src="https://factored-hackathon-2026-arabicaai.lucas-tramonte.workers.dev/arabicaai-logo.png" width="32" height="32" alt="" style="display:block;width:32px;height:32px;border-radius:16px"></td><td style="font:600 18px/24px Geist,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#121418">Arabica<span style="font-weight:400">AI</span></td></tr></table><h1 style="font-size:22px;line-height:30px">${escape(title)}</h1><p>${escape(instruction)}</p>${value ? `<div style="display:inline-block;max-width:100%;overflow-wrap:anywhere;padding:16px 10px;border:1px solid #e3e5ea;border-radius:12px;background:#f4f5f7;font:600 28px/36px monospace;letter-spacing:.03em">${escape(value)}</div>` : ''}${type === 'takeover' ? '' : `<p>${escape(copy.note)}</p>`}<p style="border-top:1px solid #e3e5ea;padding-top:16px;font-size:12px;color:#5c6370">${escape(copy.footer)}</p></td></tr></table></td></tr></table></body></html>`;
  return { lang, type, subject, text, html };
}

/** Deliver only to the trusted pool event recipient; dependency errors are sanitized. */
export function createHandler({ poolId, from, clientLocales = {}, decrypt, send, log = () => {} }) {
  return async event => {
    try {
      if (event?.userPoolId !== poolId || event?.request?.type !== 'customEmailSenderRequestV1') throw new Error();
      const message = render(event.triggerSource, clientLocales[event.callerContext?.clientId]);
      const recipient = event.request.userAttributes?.email;
      if (typeof recipient !== 'string' || !/^[^\s@<>]+@[^\s@<>]+$/.test(recipient)) throw new Error();
      let secret = '';
      if (message.type !== 'takeover') {
        if (typeof event.request.code !== 'string' || !event.request.code) throw new Error();
        secret = await decrypt(event.request.code);
        if (typeof secret !== 'string' || !secret) throw new Error();
      }
      const rendered = render(event.triggerSource, message.lang, secret);
      await send({ Source: from, Destination: { ToAddresses: [recipient] }, Message: {
        Subject: { Data: rendered.subject, Charset: 'UTF-8' }, Body: { Text: { Data: rendered.text, Charset: 'UTF-8' }, Html: { Data: rendered.html, Charset: 'UTF-8' } },
      } });
      log(JSON.stringify({ locale: rendered.lang, template: rendered.type, status: 'sent' }));
    } catch {
      // Lambda logs uncaught errors. Never propagate SDK errors, recipients, or ciphertext.
      throw new Error('Cognito email delivery failed');
    }
  };
}
