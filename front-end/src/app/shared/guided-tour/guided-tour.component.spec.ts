import { TestBed } from '@angular/core/testing';
import { GuidedTour } from './guided-tour.component';
import { LangService } from '../i18n/lang.service';

describe('GuidedTour native modal', () => {
  let launch: HTMLButtonElement;
  let help: HTMLDetailsElement;
  beforeEach(() => {
    launch = document.createElement('button'); launch.textContent = 'Launch'; document.body.append(launch);
    help = document.createElement('details'); help.id = 'tour-test-help'; help.innerHTML = '<summary>Help</summary><button id="tour-test-target">Report</button>'; document.body.append(help);
    TestBed.configureTestingModule({ imports: [GuidedTour] });
    TestBed.inject(LangService).set('es');
  });
  afterEach(() => { launch.remove(); help.remove(); });
  async function open(welcome = false) {
    const fixture = TestBed.createComponent(GuidedTour);
    fixture.componentRef.setInput('steps', [
      { targetId: 'tour-test-target', title: 'Report', body: 'Confirm before sending' },
      { targetId: 'missing-target', title: 'Reports', body: 'Follow the review' },
      { targetId: 'tour-test-help', title: 'Help', body: 'Replay here' }
    ]);
    fixture.componentRef.setInput('welcome', welcome);
    document.body.append(fixture.nativeElement); launch.focus(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    return { fixture, tour: fixture.componentInstance, dialog: fixture.nativeElement.querySelector('dialog') as HTMLDialogElement };
  }
  it('opens a native modal, opens nested Help before highlighting and never invokes a background action', async () => {
    const target = help.querySelector<HTMLButtonElement>('button')!;
    const click = jasmine.createSpy('background action'); target.onclick = click;
    const { fixture, tour, dialog } = await open();
    expect(dialog.matches(':modal')).toBeTrue(); expect(help.open).toBeTrue(); expect(tour.bounds()).not.toBeNull();
    expect(document.activeElement).toBe(dialog.querySelector('h2'));
    tour.move(1); fixture.detectChanges(); expect(tour.bounds()).toBeNull(); expect(dialog.textContent).toContain('Follow the review');
    expect(click).not.toHaveBeenCalled(); fixture.destroy(); expect(dialog.open).toBeFalse();
  });
  it('Escape skips once, closes the modal and restores launch focus', async () => {
    const { fixture, tour, dialog } = await open(true);
    const skipped = jasmine.createSpy('skipped'); tour.skipped.subscribe(skipped);
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    expect(skipped).toHaveBeenCalledTimes(1); expect(dialog.open).toBeFalse(); expect(document.activeElement).toBe(launch);
    tour.exit(); expect(skipped).toHaveBeenCalledTimes(1); fixture.destroy();
  });
  it('finishes at the highlighted Help control and translates instructions in place', async () => {
    const { fixture, tour, dialog } = await open();
    const finished = jasmine.createSpy('finished'); tour.finished.subscribe(finished);
    TestBed.inject(LangService).set('pt'); fixture.detectChanges(); expect(dialog.textContent).toContain('Passo 1 de 3');
    tour.move(2); fixture.detectChanges(); tour.exit(true);
    expect(finished).toHaveBeenCalledTimes(1); expect(document.activeElement).toBe(help.querySelector('summary')); fixture.destroy();
  });
  it('wraps Tab in both directions without focusing background controls', async () => {
    const { fixture, tour, dialog } = await open();
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    buttons.at(-1)!.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }); tour.contain(forward);
    expect(forward.defaultPrevented).toBeTrue(); expect(document.activeElement).toBe(buttons[0]);
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }); tour.contain(backward);
    expect(backward.defaultPrevented).toBeTrue(); expect(document.activeElement).toBe(buttons.at(-1)!); fixture.destroy();
  });
  it('recomputes bounds on resize/scroll and releases observers when destroyed', async () => {
    const { fixture, tour } = await open();
    const target = help.querySelector<HTMLButtonElement>('button')!;
    spyOn(target, 'getBoundingClientRect').and.returnValue({ left: 20, top: 40, right: 120, bottom: 80 } as DOMRect);
    window.dispatchEvent(new Event('resize')); expect(tour.bounds()?.left).toBe(16);
    window.dispatchEvent(new Event('scroll')); expect(tour.bounds()?.top).toBe(36);
    fixture.destroy();
  });
});
