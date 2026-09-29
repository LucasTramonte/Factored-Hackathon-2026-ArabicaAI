import { Routes } from '@angular/router';
import { AgentPage } from './features/agent/agent.page';
import { CustomerPage } from './features/customer/customer.page';

export const routes: Routes = [
  { path: '', component: CustomerPage, title: 'ArabicaAI · Report a charge' },
  { path: 'agent', component: AgentPage, title: 'ArabicaAI · Agent queue' },
  { path: '**', redirectTo: '' }
];
