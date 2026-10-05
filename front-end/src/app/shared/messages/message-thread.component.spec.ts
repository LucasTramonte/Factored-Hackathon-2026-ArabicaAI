import { TestBed } from '@angular/core/testing';
import { MessageThreadView } from './message-thread.component';
import { LangService } from '../i18n/lang.service';
import { MessageThread } from '../models/intake.model';

const THREAD: MessageThread = { status: 'in_review', can_post: true, items: [
  { message_id: 'aaaaaaaa-1111-4111-8111-111111111111', author: 'agent', body: '¿Recuerdas el comercio?', created_at: '2026-10-04T18:00:00.000Z' },
  { message_id: 'bbbbbbbb-2222-4222-8222-222222222222', author: 'customer', body: '<b>Mercado</b> el martes', created_at: '2026-10-04T18:05:00.000Z' }] };

describe('MessageThreadView', () => {
  function render(thread: MessageThread | null, viewer: 'agent' | 'customer' = 'customer') {
    TestBed.inject(LangService).set('en');
    const fixture = TestBed.createComponent(MessageThreadView);
    fixture.componentRef.setInput('thread', thread);
    fixture.componentRef.setInput('viewer', viewer);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement, c: fixture.componentInstance };
  }

  it('lists the messages oldest first, labels the reader\'s own as "You", and renders text, never HTML', () => {
    const { el } = render(THREAD, 'customer');
    const items = [...el.querySelectorAll('.message')];
    expect(items.map(li => li.querySelector('p')!.textContent)).toEqual(['¿Recuerdas el comercio?', '<b>Mercado</b> el martes']);
    expect(items[0].textContent).toContain('Bank team');
    expect(items[1].textContent).toContain('You');
    expect(items[1].classList).toContain('message-mine');
    expect(el.querySelector('b')).toBeNull();
    expect(render(THREAD, 'agent').el.querySelectorAll('.message')[0].textContent).toContain('You');
  });

  for (const [lang, title] of [['es', 'Mensajes con el equipo de revisión'], ['pt', 'Mensagens com a equipe de análise'], ['en', 'Messages with the review team']] as const) {
    it(`labels the customer human thread in ${lang}`, () => {
      const { fixture, el } = render(THREAD); TestBed.inject(LangService).set(lang); fixture.detectChanges();
      expect(el.querySelector('h3')?.textContent).toBe(title); fixture.destroy();
    });
  }

  it('emits the trimmed text, refuses an empty one with an alert, and clears the draft once the page reports it sent', () => {
    const { fixture, el, c } = render(THREAD);
    const sent: string[] = [];
    c.send.subscribe(body => sent.push(body));
    c.draft = '   ';
    c.submit(); fixture.detectChanges();
    expect(sent).toEqual([]);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Write something before sending.');
    c.draft = '  Hola  ';
    c.submit();
    expect(sent).toEqual(['Hola']);
    fixture.componentRef.setInput('sent', 1); fixture.detectChanges();
    expect(c.draft).toBe('');
  });

  it('a different report never inherits the previous one\'s draft', () => {
    const { fixture, c } = render(THREAD);
    fixture.componentRef.setInput('scope', 'report-a'); fixture.detectChanges();
    c.draft = 'para A';
    fixture.componentRef.setInput('scope', 'report-b'); fixture.detectChanges();
    expect(c.draft).toBe('');
  });

  it('is read-only once the report is closed or the thread is full, and says which', () => {
    let { el } = render({ ...THREAD, status: 'closed', can_post: false });
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.querySelector('.messages-readonly')?.textContent).toBe(TestBed.inject(LangService).t().messagesClosed);
    ({ el } = render({ ...THREAD, can_post: false }));
    expect(el.querySelector('.messages-readonly')?.textContent).toContain('message limit');
    ({ el } = render({ status: 'received', can_post: true, items: [] }));
    expect(el.querySelector('.messages-empty')?.textContent).toContain('No messages yet.');
  });

  for (const status of ['closed', 'in_review'] as const) it(`retains a focused draft read-only when refreshed ${status} prevents posting`, async () => {
    const { fixture, el, c } = render(THREAD); document.body.append(el); await fixture.whenStable();
    c.draft = 'Keep my unsent details'; fixture.detectChanges(); await fixture.whenStable();
    const area = el.querySelector<HTMLTextAreaElement>('textarea')!; area.focus(); const sent: string[] = []; c.send.subscribe(body => sent.push(body));
    fixture.componentRef.setInput('thread', { ...THREAD, status, can_post: false }); fixture.detectChanges(); await fixture.whenStable();
    expect(el.querySelector('textarea')).toBe(area); expect(document.activeElement).toBe(area); expect(area.value).toBe('Keep my unsent details'); expect(area.readOnly).toBeTrue();
    expect(el.querySelector('.messages-readonly')?.textContent).toBe(c.t()[status === 'closed' ? 'messagesClosed' : 'messagesFull']);
    el.querySelector<HTMLButtonElement>('.message-send')!.click(); c.submit(); expect(sent).toEqual([]); fixture.destroy();
  });
  it('seeds only an explicitly accepted matching-scope version, preserves edits on the same version and discards invalidated AI text', () => {
    const { fixture, c } = render(THREAD, 'agent');
    fixture.componentRef.setInput('scope', 'report-a'); fixture.detectChanges();
    c.draft = 'Manual work';
    fixture.componentRef.setInput('acceptedDraft', { body: 'Foreign draft', scope: 'report-b', version: 1 }); fixture.detectChanges();
    expect(c.draft).toBe('Manual work');
    fixture.componentRef.setInput('acceptedDraft', { body: 'Accepted by the person', scope: 'report-a', version: 2 }); fixture.detectChanges();
    expect(c.draft).toBe('Accepted by the person'); c.draft = 'Human edited';
    fixture.componentRef.setInput('acceptedDraft', { body: 'Same version', scope: 'report-a', version: 2 }); fixture.detectChanges();
    expect(c.draft).toBe('Human edited');
    fixture.componentRef.setInput('acceptedDraft', null); fixture.detectChanges(); expect(c.draft).toBe('');
    c.draft = 'Ordinary manual work'; fixture.componentRef.setInput('sendBlocked', true); fixture.detectChanges();
    const sent: string[] = []; c.send.subscribe(body => sent.push(body)); c.submit(); expect(sent).toEqual([]); expect(c.draft).toBe('Ordinary manual work');
  });

});
