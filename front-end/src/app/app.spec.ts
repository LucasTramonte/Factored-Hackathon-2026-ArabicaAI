import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App], providers: [provideRouter(routes)] }).compileComponents();
  });

  it('renders the title, the synthetic-demo notice and both views', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const page = fixture.nativeElement as HTMLElement;
    expect(page.querySelector('h1')?.textContent).toContain('ArabicaAI');
    expect(page.textContent).toContain('SYNTHETIC DEMO');
    expect([...page.querySelectorAll('nav a')].map(a => a.getAttribute('href'))).toEqual(['/', '/agent']);
  });

  it('routes the customer view at / and the agent view at /agent', () => {
    expect(routes.map(r => r.path)).toEqual(['', 'agent', '**']);
  });
});
