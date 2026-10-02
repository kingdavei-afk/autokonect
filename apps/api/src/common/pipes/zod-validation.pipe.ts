import {
  BadRequestException,
  Injectable,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodTypeAny, TypeOf } from 'zod';

/**
 * Pipe de validation base sur Zod.
 *
 * Choix : Zod plutot que class-validator. Un seul langage de schema
 * pour la validation d'entree ET les contrats partages
 * (packages/contracts), ce qui evite d'ecrire deux fois les memes
 * regles. Les messages d'erreur produits sont directement exploitables
 * par le client.
 *
 * Regle (CDCS 12.4) : un champ non declare dans le schema est REJETE,
 * pas ignore silencieusement. Ignorer un champ en trop revient a
 * accepter une requete que l'on ne maitrise pas.
 */
@Injectable()
export class ZodValidationPipe<TSchema extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown): TypeOf<TSchema> {
    const result = this.schema.safeParse(value);

    if (!result.success) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Donnees invalides.',
        details: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }

    return result.data as TypeOf<TSchema>;
  }
}

/**
 * Fabrique courte pour utiliser un schema dans un decorateur de
 * parametre : `@Body(zodPipe(CreateBookingSchema))`.
 */
export function zodPipe<TSchema extends ZodTypeAny>(
  schema: TSchema,
): ZodValidationPipe<TSchema> {
  return new ZodValidationPipe<TSchema>(schema);
}