import { isDevMode } from '@angular/core';

/** Public Cognito ids for the passwordless email sign-in (no secret: the app client is public). */
export const cognito = {
  region: 'us-east-2',
  userPoolId: 'us-east-2_Lo7KrT6MT',
  clientId: '5ak5cbjgdddso1c3h3i2aha7sn',
  clientIds: { es: '5ak5cbjgdddso1c3h3i2aha7sn', en: '315cjcdpsbnj8fb2uqti36piio', pt: '6sri1hhfiqmag7k36ks943kam' }
} as const;

/** The local demo identity picker renders only in development builds; production never calls `/demo/identities`. */
export const demoPicker = isDevMode();
