import { AfterViewInit, Component, ElementRef, OnDestroy, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { LangService } from '../i18n/lang.service';

export type TourStep = { targetId: string; title: string; body: string };

/** Native modal instructions: targets are visual only; no background action is invoked. */
@Component({
  selector: 'app-guided-tour',
  templateUrl: './guided-tour.component.html',
  styleUrl: './guided-tour.component.css'
})
export class GuidedTour implements AfterViewInit, OnDestroy {
  readonly steps = input.required<TourStep[]>();
  readonly welcome = input(false);
  readonly finished = output<void>();
  readonly skipped = output<void>();
  readonly t = inject(LangService).t;
  readonly index = signal(-1);
  readonly current = computed<TourStep | undefined>(() => this.steps()[this.index()]);
  readonly progress = computed(() => this.t().tourProgress.replace('{n}', String(this.index() + 1)).replace('{total}', String(this.steps().length)));
  readonly bounds = signal<{ left: number; top: number; width: number; height: number } | null>(null);
  readonly mask = computed(() => {
    const r = this.bounds();
    return r ? `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${r.left}px ${r.top}px, ${r.left + r.width}px ${r.top}px, ${r.left + r.width}px ${r.top + r.height}px, ${r.left}px ${r.top + r.height}px, ${r.left}px ${r.top}px)` : '';
  });
  readonly cardAtTop = computed(() => (this.bounds()?.top ?? 0) > innerHeight / 2);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private launch: HTMLElement | null = null;
  private target: HTMLElement | null = null;
  private done = false;
  private readonly resize = new ResizeObserver(() => this.measure());
  private readonly measure = () => {
    if (!this.target?.isConnected || !this.target.getClientRects().length) { this.bounds.set(null); return; }
    const r = this.target.getBoundingClientRect();
    const left = Math.max(4, r.left - 4), top = Math.max(4, r.top - 4);
    this.bounds.set({ left, top, width: Math.max(0, Math.min(innerWidth - 4, r.right + 4) - left), height: Math.max(0, Math.min(innerHeight - 4, r.bottom + 4) - top) });
  };

  ngAfterViewInit(): void {
    this.launch = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.dialog().nativeElement.showModal();
    window.addEventListener('resize', this.measure);
    window.addEventListener('scroll', this.measure, true);
    if (!this.welcome()) this.move(0);
  }

  /** Open native details ancestors before measuring; a missing target leaves usable instructions. */
  move(index: number): void {
    this.index.set(index);
    this.resize.disconnect();
    this.target = document.getElementById(this.current()?.targetId ?? '');
    for (let ancestor = this.target; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    }
    this.target?.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (this.target) this.resize.observe(this.target);
    this.measure();
    this.dialog().nativeElement.querySelector<HTMLElement>('#tour-title')?.focus();
  }

  /** Keep Tab inside the instruction card, including the boundary from its focused heading. */
  contain(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const controls = [...this.dialog().nativeElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const first = controls[0], last = controls.at(-1);
    if ((!event.shiftKey && document.activeElement === last) || (event.shiftKey && (document.activeElement === first || document.activeElement?.id === 'tour-title'))) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus();
    }
  }

  /** Close before restoring focus; completion lands on the highlighted primary control. */
  exit(complete = false): void {
    if (this.done) return;
    this.done = true;
    this.dialog().nativeElement.close();
    const destination = complete ? this.target?.querySelector<HTMLElement>('button:not(:disabled), summary, [tabindex]') ?? this.target : this.launch;
    if (destination?.isConnected) destination.focus();
    if (complete) this.finished.emit(); else this.skipped.emit();
  }

  ngOnDestroy(): void {
    this.resize.disconnect();
    window.removeEventListener('resize', this.measure);
    window.removeEventListener('scroll', this.measure, true);
    this.dialog().nativeElement.close();
  }
}
