import { Component, input } from '@angular/core';

/** The ArabicaAI mark: an accent disc with a slit. `slit` is the ground colour it sits on, so the cut reads as a cut. */
@Component({
  selector: 'app-mark',
  template: `
    <svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 64 64" aria-hidden="true" style="display: block; flex: none">
      <circle cx="32" cy="32" r="30" fill="var(--accent)"></circle>
      <rect class="slit" x="29" y="12" width="6" height="40" rx="3" [attr.fill]="slit()" transform="rotate(30 32 32)"></rect>
    </svg>`
})
export class Mark {
  readonly size = input(28);
  readonly slit = input('var(--surface)');
}
