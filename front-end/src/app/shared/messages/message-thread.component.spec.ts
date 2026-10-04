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
});
