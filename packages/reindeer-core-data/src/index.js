export { openDb, encryptExistingDb, ulid, defaultDataDir } from './db/index.js';
export {
  getMasterKey,
  deriveEstateKey,
  isEncryptionConfigured,
  generateMasterKey,
} from './crypto/estateKey.js';
export { MIGRATIONS } from './migrations/index.js';
export { SqliteAuditLog } from './audit/index.js';
export { SqliteItemRepository } from './repositories/itemRepository.js';
export { FsMediaStore, ScopeMediaStore } from './media/index.js';
export { Registry } from './registry.js';
export { PeopleRepo } from './repos/peopleRepo.js';
export { HeirsRepo } from './repos/heirsRepo.js';
export { WillsCaretakersRepo } from './repos/willsCaretakersRepo.js';
export { AddendumVersionsRepo } from './repos/addendumVersionsRepo.js';
export { ParticipantsRepo, normalizeEmail } from './repos/participantsRepo.js';
export { MagicLinksRepo, MAGIC_LINK_TTL_MINUTES } from './repos/magicLinksRepo.js';
export { SessionsRepo, SESSION_TTL_MILLISECONDS } from './repos/sessionsRepo.js';
export { MemorandumRepo } from './repos/memorandumRepo.js';
export { ReminderPrefsRepo } from './repos/reminderPrefsRepo.js';
export { createCorporateSettings } from './corporateSettings.js';
