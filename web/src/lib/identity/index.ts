/**
 * Public API des Identity-Moduls (DE 11 A.1/A.2/A.6/Block 1.H).
 *
 * Electron-Note:
 *   IndexedDB bleibt in Electron nur persistent wenn BrowserWindow mit
 *   `webPreferences: { partition: 'persist:pulse' }` erstellt wird.
 *   TODO(Desktop-Sub-Task): desktop/electron/main.ts anpassen.
 */

export { keypairStore, generateKeypair, loadKeypair, saveKeypair, wipeKeypair,
  signChallenge, exportPublicKey, supportsWebCryptoEd25519 } from './keypair.svelte';

export type { WebCryptoKeypair, StoredKeypair } from './keypair.svelte';

export { certStore, parseCertClaims, isCertExpired, isCertExpiringSoon,
  loadCert, saveCert, wipeCert } from './cert.svelte';

export type { IdentityCert, CertClaims } from './cert.svelte';

export { profileStatementStore, parseStatementClaims, isStatementExpired,
  isStatementExpiringSoon, loadProfileStatement, saveProfileStatement,
  wipeProfileStatement } from './profile-statement.svelte';

export type { ProfileStatement, ProfileStatementClaims } from './profile-statement.svelte';

export { isPrivateBrowsing, getPrivateBrowsingState,
  resetPrivateBrowsingCache } from './private-browsing';

export { runIssueFlow } from './issue-flow';
export type { IssueFlowResult } from './issue-flow';

export { startProfileRefresh, stopProfileRefresh,
  isProfileRefreshRunning } from './profile-refresh.svelte';

export { startCertRotation, stopCertRotation,
  isCertRotationRunning } from './cert-rotation.svelte';
