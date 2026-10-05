import { KmsKeyringNode, buildClient, CommitmentPolicy } from '@aws-crypto/client-node';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { createHandler } from './sender.mjs';
const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
const keyring = new KmsKeyringNode({ keyIds: [process.env.KEY_ARN] });
const ses = new SESClient({ region: process.env.AWS_REGION });
/** Native Cognito codes are decrypted with AWS Encryption SDK and delivered through SES. */
export const handler = createHandler({ poolId: process.env.POOL_ID, from: process.env.SES_FROM,
  clientLocales: JSON.parse(process.env.CLIENT_LOCALES || '{}'),
  decrypt: async ciphertext => {
    const { plaintext } = await decrypt(keyring, Buffer.from(ciphertext, 'base64'));
    return Buffer.from(plaintext).toString('utf8');
  }, send: input => ses.send(new SendEmailCommand(input)), log: line => console.log(line),
});
