import { Routes } from '@angular/router';
import { AgentPage } from './features/agent/agent.page';
import { CustomerPage } from './features/customer/customer.page';

/** The Worker serves documents at / and /agent only, so the customer flow's steps live under / and never change the URL. */
export const routes: Routes = [
  { path: '', component: CustomerPage, title: 'ArabicaAI' },
  { path: 'agent', component: AgentPage, title: 'ArabicaAI' },
  { path: '**', redirectTo: '' }
];
