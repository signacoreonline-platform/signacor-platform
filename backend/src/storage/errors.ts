/**
 * Storage errors, classified the way Sally classifies them
 * (signacore-sally: server/src/files/storage/errors.js). The message is safe
 * to show a person; it never contains a URL, a key or a credential.
 */
export type StorageErrorCode =
  | 'STORAGE_NOT_CONFIGURED' | 'STORAGE_CONFIG' | 'STORAGE_CREDENTIALS' | 'STORAGE_PERMISSION'
  | 'STORAGE_UNAVAILABLE' | 'STORAGE_WRONG_ANSWER' | 'STORAGE_MISSING' | 'STORAGE_TOO_LARGE'
  | 'STORAGE_INTEGRITY' | 'STORAGE_CORRUPT_READ' | 'STORAGE_CONFLICT' | 'STORAGE_KEY_MISMATCH';

export class StorageError extends Error {
  code: StorageErrorCode;
  status: number;
  /** True only when the failed write PROVABLY stored nothing (safe to retry). */
  notSaved: boolean;
  constructor(code: StorageErrorCode, message: string, status = 503, notSaved = false) {
    super(message);
    this.code = code; this.status = status; this.notSaved = notSaved;
  }
}

export const storageNotConfigured = (provider: string) =>
  new StorageError('STORAGE_NOT_CONFIGURED', `File storage (${provider}) is not configured on this server, so files cannot be saved or opened yet.`, 503, true);
export const storageConfig = (why: string) =>
  new StorageError('STORAGE_CONFIG', `File storage is misconfigured: ${why}.`, 503, true);
export const storageCredentials = () =>
  new StorageError('STORAGE_CREDENTIALS', 'File storage rejected this server\'s credentials.', 503, true);
export const storagePermission = () =>
  new StorageError('STORAGE_PERMISSION', 'File storage refused the request: this server\'s key is not permitted to do that.', 503, true);
export const storageUnavailable = (notSaved = false) =>
  new StorageError('STORAGE_UNAVAILABLE', 'File storage could not be reached. Please try again.', 503, notSaved);
export const storageWrongAnswer = () =>
  new StorageError('STORAGE_WRONG_ANSWER', 'Something other than the file storage answered at the configured address.', 503, false);
export const storageMissing = () =>
  new StorageError('STORAGE_MISSING', 'The file is no longer in storage.', 404, true);
export const storageTooLarge = () =>
  new StorageError('STORAGE_TOO_LARGE', 'File storage refused the file as too large.', 413, true);
export const storageIntegrity = () =>
  new StorageError('STORAGE_INTEGRITY', 'The file was damaged on its way to storage and was not saved. Please try again.', 503, true);
export const storageCorruptRead = () =>
  new StorageError('STORAGE_CORRUPT_READ', 'The stored file failed its integrity check and was not sent.', 502, false);
export const storageConflict = () =>
  new StorageError('STORAGE_CONFLICT', 'A different file is already stored under this file\'s fingerprint. Nothing was changed.', 409, true);
export const storageKeyMismatch = () =>
  new StorageError('STORAGE_KEY_MISMATCH', 'This file\'s storage reference does not belong to the configured storage.', 500, true);
