import { Inject, Injectable, Scope, type LoggerService as NestLogger } from '@nestjs/common';

import type { AppConfig } from '../config/env.validation';
import { APP_CONFIG } from '../tokens';

type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'verbose';

const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  verbose: 4,
};

interface LogFields {
  [key: string]: unknown;
}

/** Sortie d'une ligne de journal. */
type Sink = (line: string) => void;

const writeStdout: Sink = (line) => process.stdout.write(`${line}\n`);
const writeStderr: Sink = (line) => process.stderr.write(`${line}\n`);

/**
 * Journalisation structuree au format JSON.
 *
 * Exigence (CDCS 11.8) : une ligne par evenement, en JSON, filtrable,
 * correlee par request_id.
 *
 * Exigence (CDCS 12.4) : aucune donnee sensible dans un journal. Les
 * cles listees dans SENSITIVE sont remplacees par un masque avant
 * ecriture, recursivement sur toute la structure.
 *
 * Scope transient : chaque injection recoit une instance propre, ce qui
 * permet a chaque service de poser SON contexte via setContext() sans
 * interferer avec les autres.
 */
@Injectable({ scope: Scope.TRANSIENT })
export class StructuredLogger implements NestLogger {
  private context?: string;
  private fields: LogFields = {};

  /** Cles dont la valeur est remplacee par `***` avant ecriture. */
  private static readonly SENSITIVE = new Set([
    'password',
    'passwordHash',
    'password_hash',
    'token',
    'accessToken',
    'refreshToken',
    'access_token',
    'refresh_token',
    'otp',
    'code',
    'codeHash',
    'code_hash',
    'tokenHash',
    'token_hash',
    'secret',
    'authorization',
    'cookie',
    'phone',
    'email',
    'documentHash',
    'document_hash',
  ]);

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  setContext(context: string): this {
    this.context = context;
    return this;
  }

  /** Champs permanents ajoutes a chaque ligne (ex. requestId). */
  withFields(fields: LogFields): this {
    this.fields = { ...this.fields, ...fields };
    return this;
  }

  error(message: string, ...args: unknown[]): void {
    this.emit('error', message, args, writeStderr);
  }

  warn(message: string, ...args: unknown[]): void {
    this.emit('warn', message, args, writeStderr);
  }

  log(message: string, ...args: unknown[]): void {
    this.emit('info', message, args, writeStdout);
  }

  debug(message: string, ...args: unknown[]): void {
    this.emit('debug', message, args, writeStdout);
  }

  verbose(message: string, ...args: unknown[]): void {
    this.emit('verbose', message, args, writeStdout);
  }

  private emit(level: LogLevel, message: string, args: unknown[], sink: Sink): void {
    if (LEVEL_ORDER[level] > LEVEL_ORDER[this.config.log.level]) return;

    // Nest transmet le contexte du logger comme unique argument chaine.
    // On le remonte dans `ctx` plutot que de le laisser dans `args`.
    let context = this.context;
    let rest = args;

    if (args.length === 1 && typeof args[0] === 'string') {
      context = args[0];
      rest = [];
    }

    const payload: LogFields = {
      ts: new Date().toISOString(),
      level,
      app: this.config.app.name,
      prefix: this.config.log.prefix,
      ...(context ? { ctx: context } : {}),
      msg: message,
      ...this.fields,
    };

    const objects = rest.filter(
      (arg): arg is LogFields => typeof arg === 'object' && arg !== null,
    );
    const scalars = rest.filter((arg) => typeof arg !== 'object' || arg === null);

    if (scalars.length > 0) {
      payload['args'] = scalars.map((arg) => StructuredLogger.scrubValue(arg));
    }

    const scrubbed = objects.map((arg) => StructuredLogger.scrub(arg));
    if (scrubbed.length === 1) {
      payload['data'] = scrubbed[0];
    } else if (scrubbed.length > 1) {
      payload['data'] = scrubbed;
    }

    sink(JSON.stringify(payload));
  }

  /** Remplace la valeur des cles sensibles par un masque. */
  private static scrub(input: LogFields): LogFields {
    const output: LogFields = {};

    for (const [key, value] of Object.entries(input)) {
      if (StructuredLogger.SENSITIVE.has(key)) {
        output[key] = '***';
      } else if (value instanceof Error) {
        output[key] = { name: value.name, message: value.message };
      } else if (Array.isArray(value)) {
        output[key] = value.map((item) =>
          typeof item === 'object' && item !== null
            ? StructuredLogger.scrub(item as LogFields)
            : StructuredLogger.scrubValue(item),
        );
      } else if (value && typeof value === 'object') {
        output[key] = StructuredLogger.scrub(value as LogFields);
      } else {
        output[key] = value;
      }
    }

    return output;
  }

  private static scrubValue(value: unknown): unknown {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    return value;
  }
}