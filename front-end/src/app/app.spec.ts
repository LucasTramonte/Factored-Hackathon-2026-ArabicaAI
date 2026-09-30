import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

describe('App shell', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [App], providers: [provideRouter(routes)] }).compileComponents();
  });

  it('renders the router outlet only; each page carries its own chrome', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('router-outlet')).not.toBeNull();
  });

  it('routes the customer flow at / and the agent view at /agent, the two documents the Worker serves', () => {
    expect(routes.map(r => r.path)).toEqual(['', 'agent', '**']);
  });
});
