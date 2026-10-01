import { Component, inject } from '@angular/core';
import { LangService } from './lang.service';

/** The segmented language control: ES, PT, EN. The only pill-shaped control in the system. */
@Component({
  selector: 'app-lang-switch',
  template: `
    <div class="ar-seg" role="group" [attr.aria-label]="lang.t().language">
      @for (code of lang.all; track code) {
        <button type="button" [attr.lang]="code" [attr.aria-pressed]="lang.lang() === code" (click)="lang.set(code)">{{ code.toUpperCase() }}</button>
      }
    </div>`
})
export class LangSwitch {
  readonly lang = inject(LangService);
}
