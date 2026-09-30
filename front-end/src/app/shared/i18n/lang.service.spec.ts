import { TestBed } from '@angular/core/testing';
import { LangService } from './lang.service';

describe('LangService', () => {
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
  });
});
