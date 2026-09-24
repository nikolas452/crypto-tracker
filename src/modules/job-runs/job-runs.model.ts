import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import { config } from '../../config/env.js';

/**
 * Modelo de Mongoose para `job_runs`: historial de ejecuciones de jobs, con
 * los enums de estado/disparador/motivo de omisión y sus índices.
 */

export const JOB_STATUSES = ['running', 'success', 'partial', 'failed', 'skipped'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TRIGGERS = ['schedule', 'manual', 'startup'] as const;
export type JobTrigger = (typeof JOB_TRIGGERS)[number];

export const JOB_SKIP_REASONS = ['overlap', 'no_active_coins'] as const;
export type JobSkipReason = (typeof JOB_SKIP_REASONS)[number];

const jobRunErrorSchema = new Schema(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

/**
 * `job_runs`: historial de ejecución de cada corrida de job. Una colección
 * normal. `_id` también funciona como el `runId` usado en los logs. La
 * retención TTL evita que la colección crezca sin límite
 * (`JOB_RUNS_RETENTION_DAYS`, 30 por defecto).
 */
const jobRunSchema = new Schema(
  {
    jobName: { type: String, required: true },
    trigger: { type: String, required: true, enum: JOB_TRIGGERS },
    status: { type: String, required: true, enum: JOB_STATUSES },
    skipReason: { type: String, enum: JOB_SKIP_REASONS, default: null },
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    stats: {
      coinsRequested: { type: Number, required: true, default: 0 },
      coinsReturned: { type: Number, required: true, default: 0 },
      snapshotsInserted: { type: Number, required: true, default: 0 },
      skippedUnchanged: { type: Number, required: true, default: 0 },
      missingCoins: { type: [String], required: true, default: [] },
      upstreamAttempts: { type: Number, required: true, default: 0 },
      latestUpdated: { type: Number, required: true, default: 0 },
    },
    // Solo { code, message } — nunca un stack trace ni un secreto.
    error: { type: jobRunErrorSchema, default: null },
    workerId: { type: String, required: true },
  },
  {
    collection: 'job_runs',
    versionKey: false,
  },
);

jobRunSchema.index({ jobName: 1, startedAt: -1 });
jobRunSchema.index({ status: 1, startedAt: 1 });
jobRunSchema.index(
  { startedAt: 1 },
  { expireAfterSeconds: config.JOB_RUNS_RETENTION_DAYS * 86400 },
);

export type JobRunDocument = HydratedDocument<InferSchemaType<typeof jobRunSchema>>;

export const JobRunModel = model('JobRun', jobRunSchema);
