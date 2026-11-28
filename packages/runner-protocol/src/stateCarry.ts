/**
 * D#845 MC-9b2: carrying an engine's state directory from the old machine to the new one on a move. The old machine's stop uploads the state tar in chunks of 4 MiB; the cloud seals each chunk and holds it
 * until the new machine's start takes it. The signed jobs name the carry (`args.carry`); these are the sizes, the five runner routes and their messages. A chunk travels as raw bytes (base64 would push 4 MiB past
 * the platform's request limit), with the chunk's own sha256 in a header; the whole bundle's sha256 is declared once at `begin` and checked by the new runner against the signed start args.
 */
import { z } from "zod";

export const STATE_CARRY_MAX_BYTES = 50 * 1024 * 1024;
export const STATE_CARRY_CHUNK_BYTES = 4 * 1024 * 1024;
export const STATE_CARRY_MAX_CHUNKS = 13;
export const STATE_CARRY_CHUNK_SHA_HEADER = "x-fx-chunk-sha256";
/** Why an export failed: the closed list the stop may report (the database's own list is the same three). */
export const STATE_CARRY_FAIL_CODES = ["too_large", "link", "export_failed"] as const;

export const stateCarryChunkCount = (bytes: number): number => Math.ceil(bytes / STATE_CARRY_CHUNK_BYTES);
/** The exact size chunk `index` of a bundle of `bytes` has: 4 MiB, and the remainder for the last. */
export const stateCarryChunkSize = (bytes: number, index: number): number =>
  index < stateCarryChunkCount(bytes) - 1 ? STATE_CARRY_CHUNK_BYTES : bytes - (stateCarryChunkCount(bytes) - 1) * STATE_CARRY_CHUNK_BYTES;

const strict = <S extends z.ZodRawShape>(shape: S) => z.object(shape).strict();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const size = z.number().int().min(1).max(STATE_CARRY_MAX_BYTES);
const chunks = z.number().int().min(1).max(STATE_CARRY_MAX_CHUNKS);

/** The `carry` a signed start carries: what the new machine must find, checked against the bundle it assembles. */
export const StartCarryArgs = strict({ id: z.string().uuid(), bytes: size, chunks, sha256: sha256Hex }).refine((c) => c.chunks === stateCarryChunkCount(c.bytes), { message: "chunks do not match bytes" });
/** The `carry` a signed stop carries: only which carry it exports for. */
export const StopCarryArgs = strict({ id: z.string().uuid() });

export const stateCarryBeginPath = (jobId: string): string => `/api/runner/machine-job/${jobId}/carry/begin`;
export const stateCarryChunkPath = (jobId: string, index: number | string): string => `/api/runner/machine-job/${jobId}/carry/chunk/${index}`;
export const stateCarrySealPath = (jobId: string): string => `/api/runner/machine-job/${jobId}/carry/seal`;
export const stateCarryFailPath = (jobId: string): string => `/api/runner/machine-job/${jobId}/carry/fail`;
export const stateCarryImportedPath = (jobId: string): string => `/api/runner/machine-job/${jobId}/carry/imported`;

export const StateCarryBeginBody = strict({ bytes: size, chunks, sha256: sha256Hex }).refine((b) => b.chunks === stateCarryChunkCount(b.bytes), { message: "chunks do not match bytes" });
export const StateCarryFailBody = strict({ code: z.enum(STATE_CARRY_FAIL_CODES) });
/** The empty body of seal and imported. */
export const StateCarryEmptyBody = strict({});
export const StateCarryReply = strict({ recorded: z.literal(true) });
