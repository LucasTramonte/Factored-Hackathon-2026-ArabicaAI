import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** App shell: the customer flow at / and the agent view at /agent. Each page carries its own chrome. */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {}
