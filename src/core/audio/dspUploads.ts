import { ChunkUploads } from '../transfers/chunkUploads.ts'
import type { UploadFileStorage } from '../transfers/fileStorage.ts'
import { DSP_UPLOAD_CHUNK_BYTES, DSP_UPLOAD_MAX_BYTES, validDspUploadFile, type DspUploadBegin } from '../../shared/dspLibrary.ts'

export class DspUploads extends ChunkUploads<DspUploadBegin> {
  constructor(root: string, now: () => number, newId: () => string, files: UploadFileStorage) {
    super(root, now, newId, { chunkBytes: DSP_UPLOAD_CHUNK_BYTES, maxBytes: DSP_UPLOAD_MAX_BYTES,
      valid: input => validDspUploadFile(input.kind, input.fileName) }, files)
  }
}
