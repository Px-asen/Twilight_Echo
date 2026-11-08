import type { CoreModelPackDecode, CoreModelPackStatus } from '../../shared/coreModelPack.ts'

export type ModelPackPlatformCall =
  | { operation: 'chooseArchive'; payload: undefined }
  | { operation: 'decode'; payload: CoreModelPackDecode }
  | { operation: 'probe'; payload: string }
  | { operation: 'installed'; payload: boolean }

export type ModelPackWorkerRequest =
  | { kind: 'start'; root: string; enableAfterInstall: boolean; checkpointSha256?: string }
  | { kind: 'cancel' | 'shutdown' }
  | { kind: 'platform-result'; id: number; ok: true; value: unknown }
  | { kind: 'platform-result'; id: number; ok: false; error: string }

export type ModelPackWorkerMessage =
  | { kind: 'ready' }
  | { kind: 'state'; state: CoreModelPackStatus }
  | ({ kind: 'platform'; id: number } & ModelPackPlatformCall)
  | { kind: 'platform-cancel'; id: number }
  | { kind: 'finished'; state: CoreModelPackStatus }
