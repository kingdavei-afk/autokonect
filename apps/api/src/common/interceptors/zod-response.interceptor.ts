import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import type { ZodTypeAny, ZodIssue } from 'zod';

/**
 * Validation des REPONSES contre le schema de sortie.
 *
 * ------------------------------------------------------------------------
 * POURQUOI C'EST NECESSAIRE
 * ------------------------------------------------------------------------
 * Les schemas Zod n'etaient appliques qu'aux ENTREES, via `zodPipe`. Une
 * reponse pouvait donc s'ecarter de son schema sans que rien ne le
 * signale.
 *
 * Le symptome decouvert en lanccant l'interface : le schema de vehicule
 * declarait `depositAmount` comme obligatoire, le mapper ne le
 * fournissait pas, et l'interface affichait « Caution 0 XOF ». Trois
 * couches avaient le droit de mentir, aucune ne le faisait.
 *
 * ------------------------------------------------------------------------
 * CE QUE CELA CHANGE
 * ------------------------------------------------------------------------
 * Une reponse non conforme echoue IMMEDIATEMENT, en developpement, au
 * premier appel de la route concernee. Le desaccord entre le service et
 * le contrat devient un echec, et non un chiffre faux presente a un
 * client qui decide s'il signe ou non.
 *
 * C'est la seule maniere que le contrat decrit dans `@adkcars/contracts`
 * ait un effet : un schema que rien ne verifie n'est qu'une
 * documentation.
 */

/** Erreur interne : la reponse ne respecte pas son propre contrat. */
export class SchemaViolationError extends Error {
  constructor(details: string) {
    super(`Reponse non conforme au schema de sortie : ${details}`);
    this.name = 'SchemaViolationError';
  }
}

function decrire(issues: readonly ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || '(racine)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Intercepteur lie a UN schema, pour une reponse simple.
 *
 * La classe est creee par fabrique et non configuree par injection :
 * le schema est une constante de compilation, pas une dependance
 * injectable.
 */
export function zodResponse(schema: ZodTypeAny): new () => NestInterceptor {
  @Injectable()
  class ZodResponsePourCeSchema implements NestInterceptor {
    intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
      return next.handle().pipe(
        map((valeur) => {
          const resultat = schema.safeParse(valeur);

          if (resultat.success) return resultat.data;

          throw new SchemaViolationError(decrire(resultat.error.issues));
        }),
      );
    }
  }

  return ZodResponsePourCeSchema;
}

/**
 * Intercepteur lie a un schema d'ELEMENT, pour une liste.
 *
 * Chaque element est verifie separement : sur une liste de 50 vehicules,
 * un message unique ne dit pas QUEL element est fautif ni QUEL champ
 * manque. C'est precisement l'information qui rend l'erreur corrigeable.
 */
export function zodArrayResponse(itemSchema: ZodTypeAny): new () => NestInterceptor {
  @Injectable()
  class ZodArrayResponsePourCeSchema implements NestInterceptor {
    intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
      return next.handle().pipe(
        map((valeur) => {
          if (!Array.isArray(valeur)) {
            throw new SchemaViolationError(
              `un tableau etait attendu, ${typeof valeur} recu`,
            );
          }

          return valeur.map((item, index) => {
            const resultat = itemSchema.safeParse(item);

            if (resultat.success) return resultat.data;

            throw new SchemaViolationError(
              `element ${index} — ${decrire(resultat.error.issues)}`,
            );
          });
        }),
      );
    }
  }

  return ZodArrayResponsePourCeSchema;
}
