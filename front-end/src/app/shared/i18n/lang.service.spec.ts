import { TestBed } from '@angular/core/testing';
import { LangService, checkText, errorText } from './lang.service';
import { ApiError } from '../../core/http/api.service';

describe('LangService', () => {
  it('applies the initial language to the document without calling set()', () => {
    const service = TestBed.inject(LangService);
    expect(document.documentElement.lang).toBe(service.lang());
  });

  it('offers the three required languages and switches every string together', () => {
    const lang = TestBed.inject(LangService);
    expect(lang.all).toEqual(['es', 'pt', 'en']);
    lang.set('pt');
    expect(lang.t().whoAreYou).toBe('Quem é você?');
    expect(document.documentElement.lang).toBe('pt');
    lang.set('es');
    expect(lang.t().whoAreYou).toBe('¿Quién eres?');
  });

  it('never leaves a string untranslated', () => {
    const lang = TestBed.inject(LangService);
    const keys = (l: 'es' | 'pt' | 'en') => { lang.set(l); return Object.keys(lang.t()).sort(); };
    expect(keys('pt')).toEqual(keys('es'));
    expect(keys('en')).toEqual(keys('es'));
    lang.set('es'); // set() persists to localStorage: leaving 'en' would start the next spec's LangService in English
  });

  it('translates failures by status and never shows server text', () => {
    const lang = TestBed.inject(LangService);
    lang.set('pt');
    expect(errorText(lang.t(), new ApiError(503, 'raw server text'))).toBe(lang.t().err503);
    expect(errorText(lang.t(), new ApiError(0, 'network'))).toBe(lang.t().err503);
    expect(errorText(lang.t(), new ApiError(500, 'raw'))).toBe(`${lang.t().errOther} (HTTP 500)`);
    expect(errorText(lang.t(), new Error('raw'))).toBe(lang.t().errOther);
    lang.set('es');
  });

  it('labels server check codes in every language and shows an unknown code as is', () => {
    const lang = TestBed.inject(LangService);
    for (const l of ['es', 'pt', 'en'] as const) {
      lang.set(l);
      for (const code of ['owned_transaction_retrieved', 'customer_confirmation_recorded', 'transaction_lookup_failed', 'matching_transaction', 'customer_confirmation']) {
        expect(checkText(lang.t(), code)).not.toBe(code);
      }
    }
    expect(checkText(lang.t(), 'new_server_code')).toBe('new_server_code');
    lang.set('es');
  });
});
