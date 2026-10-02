import { TestBed } from '@angular/core/testing';
import { ApiService } from '../../core/http/api.service';
import { AgentService } from './agent.service';

describe('AgentService', () => {
  let api: jasmine.SpyObj<ApiService>;
  let service: AgentService;

  beforeEach(() => {
    api = jasmine.createSpyObj<ApiService>('ApiService', ['request']);
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }] });
    service = TestBed.inject(AgentService);
  });

  it('sends the ID token as a Bearer header, and none for the local one-click session', async () => {
    api.request.and.resolveTo({});
    await service.signIn('id.token');
    expect(api.request).toHaveBeenCalledWith('/demo/agent-session', {}, { Authorization: 'Bearer id.token' });
    await service.signIn();
    expect(api.request).toHaveBeenCalledWith('/demo/agent-session', {}, {});
  });

  it('reads the intake queue with GET and keeps has_more', async () => {
    api.request.and.resolveTo({ items: [], has_more: true, scope: 'synthetic_demo_only' });
    expect((await service.intakes()).has_more).toBeTrue();
    expect(api.request).toHaveBeenCalledOnceWith('/agent/intakes');
  });

  it('asks for exactly one encoded protocol', async () => {
    api.request.and.resolveTo({});
    await service.intakeDetail('a&b=c');
    expect(api.request).toHaveBeenCalledOnceWith('/agent/intake-detail?protocol=a%26b%3Dc');
  });

  it('posts exactly the protocol and the next status', async () => {
    api.request.and.resolveTo({});
    await service.setStatus('p', 'in_review');
    expect(api.request).toHaveBeenCalledOnceWith('/agent/intake-status', { protocol: 'p', status: 'in_review' });
  });
});
