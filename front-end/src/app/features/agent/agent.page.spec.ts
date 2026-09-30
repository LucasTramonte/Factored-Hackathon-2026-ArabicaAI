import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ApiError } from '../../core/http/api.service';
import { AgentPage } from './agent.page';
import { AgentService } from './agent.service';
import { Title } from '@angular/platform-browser';
import { LangService } from '../../shared/i18n/lang.service';

describe('AgentPage', () => {
  let service: jasmine.SpyObj<AgentService>;
  let page: AgentPage;

  beforeEach(async () => {
    service = jasmine.createSpyObj<AgentService>('AgentService', ['signIn', 'cases']);
    await TestBed.configureTestingModule({ imports: [AgentPage], providers: [{ provide: AgentService, useValue: service }, provideRouter([])] })
      .compileComponents();
    page = TestBed.createComponent(AgentPage).componentInstance;
  });

  it('loads cases only after starting an agent session', async () => {
    const order: string[] = [];
    service.signIn.and.callFake(async () => { order.push('session'); });
    service.cases.and.callFake(async () => { order.push('cases'); return []; });
    await page.load();
    expect(order).toEqual(['session', 'cases']);
    expect(page.loaded()).toBeTrue();
  });

  it('shows the mapped error and no stale cases when the API fails', async () => {
    service.signIn.and.rejectWith(new ApiError(401, 'Session expired.'));
    await page.load();
    expect(page.error()).toBe(TestBed.inject(LangService).t().err401);
    expect(page.cases()).toEqual([]);
    expect(page.loaded()).toBeFalse();
  });

  it('titles the tab in the interface language and follows a language switch', () => {
    const lang = TestBed.inject(LangService);
    const fixture = TestBed.createComponent(AgentPage);
    lang.set('pt');
    fixture.detectChanges();
    expect(TestBed.inject(Title).getTitle()).toBe('ArabicaAI · Visão do agente');
    lang.set('en');
    fixture.detectChanges();
    expect(TestBed.inject(Title).getTitle()).toBe('ArabicaAI · Agent view');
  });
});
